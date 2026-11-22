import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FileOperations } from "../files.js";
import {
  canonical,
  contains,
  exists,
  hasControlCharacters,
  locked,
  pathKey,
  resolvePath,
} from "../paths.js";
import {
  checkAbort,
  errorMessage,
  type OperationResult,
  type TrashBackend,
} from "../types.js";
import { encodeRegistry, MANAGED_LIMITS } from "./limits.js";
import {
  acquireFileLock,
  CURRENT_PROCESS_INSTANCE_ID,
  formatLockDiagnostics,
  isOwnerProvablyDead,
  type LockHandle,
  type LockOwner,
  tryAcquireFileLock,
  tryWithFileLock,
  withFileLock,
} from "./locks.js";
import {
  type Category,
  DEFAULT_POLICIES,
  type Item,
  LEASE_MS,
  normalizePolicyPatch,
  type Policy,
  type PolicyInput,
  planCleanup,
  type StoreState,
  validatePolicy,
} from "./model.js";
import { type HumanNumber, parseQuantity } from "./quantities.js";
import {
  readActiveSessions,
  removeSession,
  type SessionIdentity,
  touchSession,
} from "./sessions.js";
import {
  defaultSettings,
  defaultSettingsPath,
  expandHome,
  type ManagedSettings,
  readSettings,
  resolveStorageRoot,
  savePolicy,
} from "./settings.js";
import { copyTree, inspectTree, noLinks, type Tree } from "./tree.js";

export interface ManagedInput {
  action:
    | "create"
    | "list"
    | "inspect"
    | "restore"
    | "release"
    | "cleanup"
    | "policy"
    | "pin"
    | "touch";
  path?: string;
  name?: string;
  kind?: "file" | "directory";
  content?: string;
  purpose?: string;
  id?: string;
  destination?: string;
  ttlHours?: HumanNumber;
  pinned?: boolean;
  execute?: boolean;
  offset?: number;
  limit?: number;
  scope?: "session" | "project" | "all";
  policy?: PolicyInput;
}
type NormalizedInput = Omit<ManagedInput, "ttlHours" | "policy"> & {
  ttlHours?: number;
  policy?: Partial<Policy>;
};
export interface StoreOptions {
  root?: string;
  configPath?: string | false;
  now?: () => number;
  files?: FileOperations;
  lockWaitMs?: number;
  sweepCooldownMs?: number;
  autoReclaimStaleLocks?: boolean;
  session?: SessionIdentity;
}
export interface MaintainOptions {
  background?: boolean;
  signal?: AbortSignal;
  maxActions?: number;
  session?: SessionIdentity;
}
export interface ExecuteOptions {
  session?: SessionIdentity;
}

type PreInspection =
  | { ok: true; tree: Tree; verifiedAt: number }
  | { ok: false; error: string };

interface StagingMeta {
  pid: number;
  processInstanceId: string;
  hostname: string;
  startedAtMs: number;
}

const marker = ".pi-file-tools-store";
const states = [
  "creating",
  "active",
  "recycling",
  "recycled",
  "purging",
  "purged",
  "failed",
];
const UNRESOLVED_STATES = ["creating", "recycling", "purging"];
const DEFAULT_LOCK_WAIT_MS = 15_000;
const DEFAULT_SWEEP_COOLDOWN_MS = 5 * 60 * 1000;

export class ManagedStore {
  readonly root: string;
  readonly settingsPath: string | undefined;
  private readonly rootOverride: string | undefined;
  private readonly now: () => number;
  private readonly files: FileOperations;
  private readonly lockWaitMsOverride: number | undefined;
  private readonly sweepCooldownMsOverride: number | undefined;
  private readonly autoReclaimOverride: boolean | undefined;
  private readonly defaultSession: SessionIdentity | undefined;
  constructor(
    private readonly trash: TrashBackend,
    options: StoreOptions = {},
  ) {
    // Explicit test/programmatic roots do not read a user's live configuration.
    this.settingsPath =
      options.configPath === false ||
      (options.root !== undefined && options.configPath === undefined)
        ? undefined
        : resolvePath(
            expandHome(
              options.configPath ??
                process.env.PI_FILE_TOOLS_CONFIG ??
                defaultSettingsPath(),
            ),
            process.cwd(),
          );
    this.rootOverride = options.root ?? process.env.PI_FILE_TOOLS_HOME;
    const settings: ManagedSettings = this.settingsPath
      ? readSettings(this.settingsPath)
      : { version: 1 };
    this.root = resolveStorageRoot(
      this.rootOverride ??
        settings.storageRoot ??
        (defaultSettings().storageRoot as string),
    );
    this.now = options.now ?? Date.now;
    this.files = options.files ?? new FileOperations(trash);
    this.lockWaitMsOverride = options.lockWaitMs;
    this.sweepCooldownMsOverride = options.sweepCooldownMs;
    this.autoReclaimOverride = options.autoReclaimStaleLocks;
    this.defaultSession = options.session;
  }
  private settings(): ManagedSettings {
    const settings = this.settingsPath
      ? readSettings(this.settingsPath)
      : { version: 1 as const };
    const root = resolveStorageRoot(
      this.rootOverride ??
        settings.storageRoot ??
        (defaultSettings().storageRoot as string),
    );
    if (pathKey(root) !== pathKey(this.root))
      throw new Error(
        "storageRoot changed; reload the Pi extension before accessing another store. Existing data is not migrated automatically.",
      );
    return settings;
  }
  private lockWaitMs(settings: ManagedSettings): number {
    return (
      this.lockWaitMsOverride ?? settings.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS
    );
  }
  private sweepCooldownMs(settings: ManagedSettings): number {
    if (this.sweepCooldownMsOverride !== undefined)
      return this.sweepCooldownMsOverride;
    if (settings.sweepCooldownMinutes !== undefined)
      return settings.sweepCooldownMinutes * 60_000;
    return DEFAULT_SWEEP_COOLDOWN_MS;
  }
  private autoReclaimStale(settings: ManagedSettings): boolean {
    return this.autoReclaimOverride ?? settings.autoReclaimStaleLocks ?? true;
  }
  private itemLockPath(id: string): string {
    return path.join(this.root, ".item-locks", `${id}.lock`);
  }
  private async canReclaimStoreLock(): Promise<{
    ok: boolean;
    reason?: string;
  }> {
    const statePath = path.join(this.root, "state.json");
    if (!(await exists(statePath))) return { ok: true };
    try {
      await noLinks(statePath);
      const info = await lstat(statePath);
      if (!info.isFile() || info.size > MANAGED_LIMITS.registryBytes)
        return { ok: false, reason: "Registry file is invalid or oversized." };
      const state = JSON.parse(await readFile(statePath, "utf8")) as StoreState;
      if (!Array.isArray(state.items))
        return { ok: false, reason: "Registry items array is malformed." };
      const unresolved = state.items.filter((i) =>
        UNRESOLVED_STATES.includes(i.state),
      );
      if (unresolved.length)
        return {
          ok: false,
          reason: `Unresolved managed operations exist (${unresolved.map((i) => i.id).join(", ")}); inspect state before clearing lock.`,
        };
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: `Registry could not be verified (${errorMessage(error)}).`,
      };
    }
  }
  private async ensureRootDirectory(initialize: boolean): Promise<boolean> {
    if (!(await exists(this.root))) {
      if (!initialize) return false;
      await noLinks(this.root);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
    }
    await noLinks(this.root);
    const rootInfo = await lstat(this.root);
    if (
      !rootInfo.isDirectory() ||
      (process.platform === "linux" &&
        (rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o077) !== 0))
    )
      throw new Error(
        "Managed root must be a private, current-user directory.",
      );
    return true;
  }
  private async readAndValidateState(
    settings: ManagedSettings,
  ): Promise<StoreState> {
    const markerPath = path.join(this.root, marker);
    const statePath = path.join(this.root, "state.json");
    if ((await readFile(markerPath, "utf8")) !== "pi-file-tools-managed-v1\n")
      throw new Error("Unknown store marker; refusing to overwrite.");
    await noLinks(statePath);
    const file = await lstat(statePath);
    if (!file.isFile() || file.size > MANAGED_LIMITS.registryBytes)
      throw new Error("Invalid or oversized store registry.");
    const state = JSON.parse(await readFile(statePath, "utf8")) as StoreState;
    await this.validateState(state);
    for (const category of ["backup", "temp"] as const) {
      state.policies[category] = {
        ...state.policies[category],
        ...settings.policies?.[category],
      };
      validatePolicy(state.policies[category]);
    }
    return state;
  }
  private async readSnapshot(): Promise<StoreState | undefined> {
    const settings = this.settings();
    if (!(await this.ensureRootDirectory(false))) return undefined;
    const markerPath = path.join(this.root, marker);
    const statePath = path.join(this.root, "state.json");
    if (!(await exists(markerPath)) || !(await exists(statePath)))
      return undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.readAndValidateState(settings);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const msg = errorMessage(error);
        const transient =
          code === "ENOENT" ||
          code === "EPERM" ||
          code === "EBUSY" ||
          msg.startsWith("Unregistered managed directory ");
        if (attempt < 2 && transient) {
          await delay(25);
          continue;
        }
        if (msg.startsWith("Unregistered managed directory "))
          return this.transaction(
            async (state) => structuredClone(state),
            false,
          );
        throw error;
      }
    }
    return undefined;
  }
  private async transaction<T>(
    fn: (state: StoreState, save: () => Promise<void>) => Promise<T>,
    initialize = true,
    options: {
      operation?: string;
      waitMs?: number;
      signal?: AbortSignal;
      sessionId?: string;
    } = {},
  ): Promise<T | undefined> {
    const settings = this.settings();
    if (!(await this.ensureRootDirectory(initialize))) return undefined;
    const lock = path.join(this.root, ".lock");
    const waitMs = options.waitMs ?? this.lockWaitMs(settings);
    const lockOptions = {
      lockPath: lock,
      operation: options.operation ?? "managed:transaction",
      waitMs,
      sessionId: options.sessionId ?? this.defaultSession?.sessionId,
      signal: options.signal,
      autoReclaimStale: this.autoReclaimStale(settings),
      canReclaimStale: () => this.canReclaimStoreLock(),
      onStaleReclaimed: ({
        owner,
        reason,
      }: {
        lockPath: string;
        owner?: LockOwner;
        reason: string;
      }) => {
        console.warn(
          `[pi-file-tools] Reclaimed stale store lock (${reason}): ${formatLockDiagnostics(lock, owner)}`,
        );
      },
      busyMessage: (lockPath: string, owner?: LockOwner) =>
        `Managed store is locked: ${formatLockDiagnostics(lockPath, owner)}. Never auto-remove a possibly live lock; inspect other Pi sessions first.`,
    };
    const runInsideLock = async (): Promise<T | undefined> => {
      const markerPath = path.join(this.root, marker);
      const statePath = path.join(this.root, "state.json");
      if (!(await exists(markerPath))) {
        if (!initialize) return undefined;
        if (
          (await readdir(this.root)).some(
            (name) =>
              ![
                ".lock",
                ".maintenance.lock",
                ".staging",
                ".item-locks",
                "sessions",
              ].includes(name) &&
              !name.startsWith(".lock-owner-") &&
              !name.startsWith(".lock.stale-"),
          )
        )
          throw new Error(
            "Refusing to adopt a non-empty unmarked managed directory.",
          );
        await writeFile(markerPath, "pi-file-tools-managed-v1\n", {
          flag: "wx",
          mode: 0o600,
        });
        for (const name of ["backup", "temp"])
          await mkdir(path.join(this.root, name), { mode: 0o700 });
        await this.atomic(statePath, {
          version: 1,
          policies: structuredClone(DEFAULT_POLICIES),
          items: [],
          lastSweep: 0,
        });
      }
      const state = await this.readAndValidateState(settings);
      const save = () => this.atomic(statePath, state);
      return await fn(state, save);
    };
    return withFileLock(lockOptions, runInsideLock);
  }
  private async tryTransaction<T>(
    fn: (state: StoreState, save: () => Promise<void>) => Promise<T>,
    options: {
      operation: string;
      waitMs: number;
      signal?: AbortSignal;
      sessionId?: string;
    },
  ): Promise<{ acquired: true; value: T | undefined } | { acquired: false }> {
    const settings = this.settings();
    if (!(await this.ensureRootDirectory(false)))
      return { acquired: true, value: undefined };
    const lock = path.join(this.root, ".lock");
    const attempt = await tryWithFileLock(
      {
        lockPath: lock,
        operation: options.operation,
        waitMs: options.waitMs,
        sessionId: options.sessionId ?? this.defaultSession?.sessionId,
        signal: options.signal,
        autoReclaimStale: this.autoReclaimStale(settings),
        canReclaimStale: () => this.canReclaimStoreLock(),
        onStaleReclaimed: ({ owner, reason }) => {
          console.warn(
            `[pi-file-tools] Reclaimed stale store lock (${reason}): ${formatLockDiagnostics(lock, owner)}`,
          );
        },
      },
      async () => {
        const markerPath = path.join(this.root, marker);
        if (!(await exists(markerPath))) return undefined;
        const state = await this.readAndValidateState(settings);
        const statePath = path.join(this.root, "state.json");
        const save = () => this.atomic(statePath, state);
        return await fn(state, save);
      },
    );
    if (!attempt.acquired) return { acquired: false };
    return { acquired: true, value: attempt.value };
  }
  private async atomic(target: string, value: unknown): Promise<void> {
    const encoded = encodeRegistry(value);
    const temporary = path.join(this.root, `.state-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(encoded);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  }
  private async validateState(state: StoreState): Promise<void> {
    if (
      state.version !== 1 ||
      !state.policies ||
      !Array.isArray(state.items) ||
      state.items.length > MANAGED_LIMITS.registryItems ||
      !Number.isFinite(state.lastSweep)
    )
      throw new Error("Malformed managed registry; refusing maintenance.");
    for (const category of ["backup", "temp"] as const) {
      validatePolicy(state.policies[category]);
      await noLinks(path.join(this.root, category));
    }
    const ids = new Set<string>();
    const registered = new Set<string>();
    for (const item of state.items) {
      if (
        !/^(backup|temp)-[0-9a-f-]{36}$/u.test(item.id) ||
        ids.has(item.id) ||
        !["backup", "temp"].includes(item.category) ||
        !states.includes(item.state) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        !Number.isFinite(item.createdAt) ||
        !Number.isFinite(item.expiresAt) ||
        !Number.isFinite(item.leaseUntil) ||
        typeof item.pinned !== "boolean" ||
        !["file", "directory"].includes(item.kind) ||
        typeof item.purpose !== "string" ||
        typeof item.owner !== "string" ||
        typeof item.project !== "string"
      )
        throw new Error("Invalid managed item metadata; refusing maintenance.");
      if (
        (item.inspectionError !== undefined &&
          typeof item.inspectionError !== "string") ||
        (item.lastVerifiedAt !== undefined &&
          !Number.isFinite(item.lastVerifiedAt)) ||
        (item.linkCount !== undefined &&
          (!Number.isSafeInteger(item.linkCount) || item.linkCount < 0)) ||
        (item.sessionId !== undefined &&
          (typeof item.sessionId !== "string" || !item.sessionId)) ||
        (item.sessionFile !== undefined &&
          typeof item.sessionFile !== "string") ||
        (item.pid !== undefined &&
          (!Number.isSafeInteger(item.pid) || item.pid <= 0)) ||
        (item.host !== undefined && typeof item.host !== "string")
      )
        throw new Error("Invalid inspection health metadata.");
      ids.add(item.id);
      registered.add(`${item.category}/${item.id}`);
      const expected = path.join(this.root, item.category, item.id, item.name);
      if (
        !item.name ||
        path.basename(item.name) !== item.name ||
        item.name === "." ||
        item.name === ".." ||
        pathKey(expected) !== pathKey(item.path)
      )
        throw new Error("Managed item path escaped its registered location.");
      if (
        item.category === "backup" &&
        item.state === "active" &&
        !/^[a-f0-9]{64}$/u.test(item.digest ?? "")
      )
        throw new Error("Backup digest missing or invalid.");
      if (
        ["recycled", "purging"].includes(item.state) &&
        (!item.trashId || !Number.isFinite(item.recycledAt))
      )
        throw new Error("Recycled item has no valid OS identity or timestamp.");
    }
    for (const category of ["backup", "temp"] as const)
      for (const name of await readdir(path.join(this.root, category)))
        if (!registered.has(`${category}/${name}`))
          throw new Error(
            `Unregistered managed directory ${name}; preserve and reconcile it before maintenance.`,
          );
  }
  private async inspectItem(
    item: Item,
    signal?: AbortSignal,
    hashFiles = item.category === "backup",
  ): Promise<Tree> {
    try {
      await noLinks(item.path);
      const tree = await inspectTree(
        item.path,
        MANAGED_LIMITS.maxBytes,
        signal,
        item.category === "temp" ? "opaque" : "reject",
        hashFiles,
      );
      if (item.category === "backup" && tree.digest !== item.digest)
        throw new Error(
          `Backup integrity check failed: ${item.id}; no cleanup performed.`,
        );
      item.bytes = tree.bytes;
      item.linkCount = tree.linkCount;
      item.lastVerifiedAt = this.now();
      delete item.inspectionError;
      return tree;
    } catch (error) {
      checkAbort(signal);
      item.inspectionError = errorMessage(error).slice(0, 2000);
      throw error;
    }
  }
  private async preInspectCategory(
    state: StoreState,
    category: Category,
    signal?: AbortSignal,
  ): Promise<{ startedAt: number; results: Map<string, PreInspection> }> {
    const startedAt = this.now();
    const results = new Map<string, PreInspection>();
    const hashFiles = category === "backup";
    for (const item of state.items.filter(
      (i) => i.state === "active" && i.category === category,
    )) {
      checkAbort(signal);
      try {
        await noLinks(item.path);
        const tree = await inspectTree(
          item.path,
          MANAGED_LIMITS.maxBytes,
          signal,
          category === "temp" ? "opaque" : "reject",
          hashFiles,
        );
        if (category === "backup" && tree.digest !== item.digest)
          throw new Error(
            `Backup integrity check failed: ${item.id}; no cleanup performed.`,
          );
        results.set(item.id, { ok: true, tree, verifiedAt: this.now() });
      } catch (error) {
        checkAbort(signal);
        results.set(item.id, {
          ok: false,
          error: errorMessage(error).slice(0, 2000),
        });
      }
    }
    return { startedAt, results };
  }
  private async applyPreInspection(
    state: StoreState,
    category: Category,
    pre: { startedAt: number; results: Map<string, PreInspection> } | undefined,
    owner?: string,
    activeSessionIds?: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<{ id: string; error: string }[]> {
    const failed: { id: string; error: string }[] = [];
    const now = this.now();
    for (const item of state.items.filter(
      (i) => i.state === "active" && i.category === category,
    )) {
      const cached = pre?.results.get(item.id);
      if (pre && cached && (item.lastVerifiedAt ?? 0) <= pre.startedAt) {
        if (cached.ok) {
          item.bytes = cached.tree.bytes;
          item.linkCount = cached.tree.linkCount;
          item.lastVerifiedAt = cached.verifiedAt;
          delete item.inspectionError;
          if (
            item.category === "temp" &&
            ((owner && item.owner === owner && item.leaseUntil > now) ||
              (item.sessionId !== undefined &&
                activeSessionIds?.has(item.sessionId) === true &&
                item.expiresAt > now))
          )
            item.leaseUntil = now + LEASE_MS;
        } else {
          item.inspectionError = cached.error;
          failed.push({ id: item.id, error: cached.error });
        }
        continue;
      }
      try {
        await this.inspectItem(item, signal, category === "backup");
        if (
          item.category === "temp" &&
          ((owner && item.owner === owner && item.leaseUntil > now) ||
            (item.sessionId !== undefined &&
              activeSessionIds?.has(item.sessionId) === true &&
              item.expiresAt > now))
        )
          item.leaseUntil = now + LEASE_MS;
      } catch (error) {
        checkAbort(signal);
        failed.push({ id: item.id, error: errorMessage(error) });
      }
    }
    return failed;
  }
  private async copyOut(
    item: Item,
    tree: Tree,
    destination: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!tree.hashed)
      throw new Error("Restore verification requires a content digest.");
    const links = item.category === "temp" ? "opaque" : "reject";
    await this.files.transfer(
      "copy",
      { source: item.path, destination, recursive: tree.kind === "directory" },
      cwd,
      signal,
      (source, target, _recursive, copySignal) =>
        copyTree(source, target, tree, copySignal, links),
    );
    if (
      (
        await inspectTree(
          destination,
          MANAGED_LIMITS.maxBytes,
          signal,
          links,
          true,
        )
      ).digest !== tree.digest
    )
      throw new Error(
        `Restore verification failed; preserve destination ${destination}.`,
      );
  }
  private allowed(category: Category, input: NormalizedInput): void {
    const fields: Record<ManagedInput["action"], string[]> = {
      create:
        category === "backup"
          ? ["path", "purpose", "ttlHours", "pinned"]
          : ["name", "kind", "content", "purpose", "ttlHours", "pinned"],
      list: ["offset", "limit", "scope"],
      inspect: ["id"],
      restore: ["id", "destination"],
      release: ["id", "execute"],
      cleanup: ["execute"],
      policy: ["policy", "execute"],
      pin: ["id", "pinned"],
      touch: ["id", "ttlHours"],
    };
    if (!Object.hasOwn(fields, input.action))
      throw new Error("Unknown managed operation.");
    for (const key of Object.keys(input))
      if (key !== "action" && !fields[input.action].includes(key))
        throw new Error(
          `Parameter ${key} does not apply to ${category} ${input.action}.`,
        );
    if (
      input.scope !== undefined &&
      !["session", "project", "all"].includes(input.scope)
    )
      throw new Error("list scope must be session, project, or all.");
    if (
      input.ttlHours !== undefined &&
      (!Number.isFinite(input.ttlHours) ||
        input.ttlHours < 1 ||
        input.ttlHours > MANAGED_LIMITS.maxHours)
    )
      throw new Error(`ttlHours must be 1..${MANAGED_LIMITS.maxHours} hours.`);
  }
  private async outside(value: string): Promise<void> {
    const target = await canonical(value);
    const root = await canonical(this.root);
    if (contains(root, target) || contains(target, root))
      throw new Error("Source/destination overlaps the managed store.");
  }
  private find(state: StoreState, category: Category, id?: string): Item {
    const item = state.items.find(
      (i) => i.id === id && i.category === category,
    );
    if (!item) throw new Error("Managed item not found in this category.");
    return item;
  }
  private async recycle(
    _state: StoreState,
    item: Item,
    save: () => Promise<void>,
    options: { skipIfRestoring?: boolean } = {},
  ): Promise<boolean> {
    const itemLock = await tryAcquireFileLock({
      lockPath: this.itemLockPath(item.id),
      operation: `${item.category}:recycle`,
      waitMs: 0,
      autoReclaimStale: true,
    });
    if (!itemLock.acquired) {
      if (options.skipIfRestoring) return false;
      throw new Error(
        `Item ${item.id} is currently being restored by another operation; retry after restore completes.`,
      );
    }
    try {
      await this.inspectItem(item, undefined, item.category === "backup");
      item.state = "recycling";
      await save();
      try {
        const result = await this.trash.put(item.path);
        if (
          pathKey(result.originalPath) !== pathKey(item.path) ||
          (await exists(item.path))
        )
          throw new Error("OS recycle outcome uncertain.");
        item.trashId = result.id;
        item.recycledAt = this.now();
        item.state = "recycled";
        delete item.error;
        await save();
        return true;
      } catch (error) {
        item.error = `Recycle outcome may be uncertain; inspect source and OS bin before retry: ${errorMessage(error)}`;
        await save();
        throw error;
      }
    } finally {
      await itemLock.handle.release();
    }
  }
  private async applyCleanup(
    state: StoreState,
    category: Category,
    save: () => Promise<void>,
    inspectionFailures: { id: string; error: string }[] = [],
    activeSessionIds?: ReadonlySet<string>,
    maxActions = Number.POSITIVE_INFINITY,
  ): Promise<OperationResult> {
    const plan = planCleanup(state, category, this.now(), activeSessionIds);
    const released: string[] = [];
    const purged: string[] = [];
    const failed: { id: string; error: string }[] = [...inspectionFailures];
    let actions = 0;
    const selectedPurge = Number.isFinite(maxActions)
      ? plan.purge.slice(0, Math.max(0, maxActions))
      : plan.purge;
    // Validate every selected OS id against its original registered path before any purge.
    const bin = selectedPurge.length ? await this.trash.list() : [];
    for (const row of selectedPurge) {
      const item = this.find(state, category, row.id);
      const match = bin.find((i) => i.id === item.trashId);
      if (!match || pathKey(match.originalPath) !== pathKey(item.path))
        throw new Error(
          `OS bin identity mismatch for ${item.id}; no purge performed.`,
        );
    }
    for (const row of plan.recycle) {
      if (actions >= maxActions) break;
      const item = this.find(state, category, row.id);
      try {
        const didRecycle = await this.recycle(state, item, save, {
          skipIfRestoring: Number.isFinite(maxActions),
        });
        if (didRecycle) {
          released.push(item.id);
          actions++;
        }
      } catch (error) {
        failed.push({ id: item.id, error: errorMessage(error) });
        if (item.state !== "active") break;
        await save();
      }
    }
    for (const row of selectedPurge) {
      if (actions >= maxActions) break;
      const item = this.find(state, category, row.id);
      item.state = "purging";
      await save();
      try {
        const result = await this.trash.purge([item.trashId as string]);
        if (
          result.failed.length ||
          !result.removed.includes(item.trashId as string)
        )
          throw new Error(JSON.stringify(result));
        item.state = "purged";
        delete item.error;
        await save();
        purged.push(item.id);
        actions++;
      } catch (error) {
        item.error = `Purge outcome uncertain: ${errorMessage(error)}`;
        await save();
        failed.push({ id: item.id, error: item.error });
        break;
      }
    }
    return {
      plan,
      status: failed.length ? "partial" : "ok",
      released,
      purged,
      failed,
      physicalBytesFreed: null,
      note: "Released items remain in OS trash until their recorded purge. Physical disk reclamation is not measured.",
    };
  }
  private async cleanStaleStaging(): Promise<void> {
    const now = Date.now();
    try {
      for (const name of await readdir(this.root)) {
        if (!name.startsWith(".lock-owner-") || !name.endsWith(".tmp"))
          continue;
        const file = path.join(this.root, name);
        const info = await lstat(file).catch(() => undefined);
        if (info?.isFile() && now - info.mtimeMs > 60_000)
          await rm(file, { force: true }).catch(() => undefined);
      }
    } catch {
      // Ignore transient root listing errors.
    }
    const stagingRoot = path.join(this.root, ".staging");
    if (!(await exists(stagingRoot))) return;
    await noLinks(stagingRoot);
    const entries = await readdir(stagingRoot);
    for (const entry of entries) {
      if (!entry.endsWith(".meta.json")) continue;
      const metaPath = path.join(stagingRoot, entry);
      const id = entry.slice(0, -".meta.json".length);
      const payloadDir = path.join(stagingRoot, id);
      try {
        const meta = JSON.parse(
          await readFile(metaPath, "utf8"),
        ) as Partial<StagingMeta>;
        if (
          typeof meta.pid === "number" &&
          typeof meta.processInstanceId === "string" &&
          typeof meta.hostname === "string" &&
          typeof meta.startedAtMs === "number" &&
          isOwnerProvablyDead(
            {
              pid: meta.pid,
              processInstanceId: meta.processInstanceId,
              hostname: meta.hostname,
              operation: "backup:staging",
              startedAt: "",
              startedAtMs: meta.startedAtMs,
            },
            now,
            5000,
          ).dead
        ) {
          if (await exists(payloadDir)) {
            await noLinks(payloadDir);
            await rm(payloadDir, { recursive: true, force: false });
          }
          await rm(metaPath, { force: true });
        }
      } catch {
        // Ignore transient or active staging entries.
      }
    }
  }
  async touchSessionHeartbeat(session?: SessionIdentity): Promise<void> {
    const effective = session ?? this.defaultSession;
    if (!effective?.sessionId) return;
    await touchSession(this.root, effective, this.now());
  }
  async endSession(sessionId?: string): Promise<void> {
    const id = sessionId ?? this.defaultSession?.sessionId;
    if (!id) return;
    await removeSession(this.root, id);
  }
  async maintain(
    owner?: string,
    options: MaintainOptions = {},
  ): Promise<OperationResult> {
    const settings = this.settings();
    checkAbort(options.signal);
    if (!(await this.ensureRootDirectory(false)))
      return { root: this.root, initialized: false };
    const markerPath = path.join(this.root, marker);
    if (!(await exists(markerPath)))
      return { root: this.root, initialized: false };

    const runSweep = async (): Promise<OperationResult> => {
      const snapshot = await this.readSnapshot();
      if (!snapshot) return { root: this.root, initialized: false };

      const now = this.now();
      const cooldownMs = this.sweepCooldownMs(settings);
      if (options.background && cooldownMs > 0 && snapshot.lastSweep > 0) {
        const hasUnresolved = snapshot.items.some((i) =>
          UNRESOLVED_STATES.includes(i.state),
        );
        const hasInspectionErrors = snapshot.items.some(
          (i) => i.state === "active" && i.inspectionError !== undefined,
        );
        const activeSessions = await readActiveSessions(this.root, now);
        const backupPlan = planCleanup(snapshot, "backup", now, activeSessions);
        const tempPlan = planCleanup(snapshot, "temp", now, activeSessions);
        const hasDueWork =
          backupPlan.recycle.length > 0 ||
          backupPlan.purge.length > 0 ||
          tempPlan.recycle.length > 0 ||
          tempPlan.purge.length > 0 ||
          backupPlan.overBudget ||
          tempPlan.overBudget;
        if (
          !hasUnresolved &&
          !hasInspectionErrors &&
          !hasDueWork &&
          now - snapshot.lastSweep < cooldownMs
        )
          return {
            root: this.root,
            skipped: true,
            reason: "recent-sweep",
            lastSweep: snapshot.lastSweep,
          };
      }

      await this.cleanStaleStaging();
      const activeSessionIds = await readActiveSessions(this.root, now);
      const backupPre = await this.preInspectCategory(
        snapshot,
        "backup",
        options.signal,
      );
      const tempPre = await this.preInspectCategory(
        snapshot,
        "temp",
        options.signal,
      );

      const commit = async (
        state: StoreState,
        save: () => Promise<void>,
      ): Promise<OperationResult> => {
        const stillUnresolved = state.items.filter((i) =>
          UNRESOLVED_STATES.includes(i.state),
        );
        if (stillUnresolved.length)
          throw new Error(
            `Unresolved managed operations: ${stillUnresolved.map((i) => i.id).join(", ")}; preserve evidence and inspect before maintenance.`,
          );
        const backupFailures = await this.applyPreInspection(
          state,
          "backup",
          backupPre,
          owner,
          activeSessionIds,
          options.signal,
        );
        const tempFailures = await this.applyPreInspection(
          state,
          "temp",
          tempPre,
          owner,
          activeSessionIds,
          options.signal,
        );
        await save();
        const maxActions = options.maxActions ?? Number.POSITIVE_INFINITY;
        const backup = await this.applyCleanup(
          state,
          "backup",
          save,
          backupFailures,
          activeSessionIds,
          maxActions,
        );
        const remaining = Number.isFinite(maxActions)
          ? Math.max(
              0,
              maxActions -
                ((backup.released as string[]).length +
                  (backup.purged as string[]).length),
            )
          : Number.POSITIVE_INFINITY;
        const temp = await this.applyCleanup(
          state,
          "temp",
          save,
          tempFailures,
          activeSessionIds,
          remaining,
        );
        const failed = [
          ...(backup.failed as unknown[]),
          ...(temp.failed as unknown[]),
        ];
        if (!failed.length) state.lastSweep = this.now();
        await save();
        const failedItems = state.items
          .filter((i) => i.state === "failed")
          .map((i) => ({
            id: i.id,
            category: i.category,
            error: i.error ?? "failed",
          }));
        return {
          root: this.root,
          status: failed.length ? "partial" : "ok",
          failed,
          ...(failedItems.length ? { failedItems } : {}),
          backup,
          temp,
        };
      };

      if (options.background) {
        const attempt = await this.tryTransaction(commit, {
          operation: "managed:maintain:background",
          waitMs: Math.min(this.lockWaitMs(settings), 1000),
          signal: options.signal,
          sessionId: options.session?.sessionId,
        });
        if (!attempt.acquired)
          return { root: this.root, skipped: true, reason: "store-busy" };
        return attempt.value ?? { root: this.root, initialized: false };
      }
      const result = await this.transaction(commit, false, {
        operation: "managed:maintain",
        signal: options.signal,
        sessionId: options.session?.sessionId,
      });
      return result ?? { root: this.root, initialized: false };
    };

    if (options.background) {
      const maintLock = await tryWithFileLock(
        {
          lockPath: path.join(this.root, ".maintenance.lock"),
          operation: "managed:maintain:background",
          waitMs: 0,
          sessionId:
            options.session?.sessionId ?? this.defaultSession?.sessionId,
          signal: options.signal,
          autoReclaimStale: this.autoReclaimStale(settings),
        },
        runSweep,
      );
      if (!maintLock.acquired)
        return {
          root: this.root,
          skipped: true,
          reason: "maintenance-in-progress",
        };
      return maintLock.value;
    }
    return runSweep();
  }
  async execute(
    category: Category,
    rawInput: ManagedInput,
    cwd: string,
    owner = "manual",
    signal?: AbortSignal,
    options: ExecuteOptions = {},
  ): Promise<OperationResult> {
    const { ttlHours, policy, ...rest } = rawInput;
    const input: NormalizedInput = {
      ...rest,
      ...(ttlHours !== undefined
        ? { ttlHours: parseQuantity(ttlHours, "hours", "ttlHours") }
        : {}),
      ...(policy !== undefined ? { policy: normalizePolicyPatch(policy) } : {}),
    };
    this.allowed(category, input);
    checkAbort(signal);
    const session = options.session ?? this.defaultSession;
    if (session?.sessionId)
      await touchSession(this.root, { ...session, cwd }, this.now()).catch(
        () => undefined,
      );

    // Lock-free read path for list, inspect, and policy preview once the store exists.
    if (
      input.action === "list" ||
      input.action === "inspect" ||
      (input.action === "policy" && !input.execute)
    ) {
      const snapshot = await this.readSnapshot();
      if (snapshot) {
        if (input.action === "policy") {
          const current = snapshot.policies[category];
          const proposed = { ...current, ...input.policy };
          validatePolicy(proposed);
          return {
            category,
            root: this.root,
            settingsPath: this.settingsPath ?? null,
            current,
            proposed,
            applied: false,
          };
        }
        if (input.action === "list") {
          const offset = input.offset ?? 0;
          const limit = input.limit ?? 100;
          if (
            !Number.isInteger(offset) ||
            offset < 0 ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 200
          )
            throw new Error("List offset/limit invalid (limit 1..200).");
          const scope = input.scope ?? "all";
          const projectKey = pathKey(path.resolve(cwd));
          const items = snapshot.items
            .filter((i) => {
              if (i.category !== category) return false;
              if (scope === "session")
                return (
                  session?.sessionId !== undefined &&
                  i.sessionId === session.sessionId
                );
              if (scope === "project") return pathKey(i.project) === projectKey;
              return true;
            })
            .sort((a, b) => b.createdAt - a.createdAt);
          return {
            root: this.root,
            policy: snapshot.policies[category],
            scope,
            currentSessionId: session?.sessionId ?? null,
            total: items.length,
            items: items.slice(offset, offset + limit),
            nextOffset: offset + limit < items.length ? offset + limit : null,
          };
        }
        return {
          item: this.find(snapshot, category, input.id),
          root: this.root,
        };
      }
    }

    if (input.action === "restore") {
      return this.executeRestore(category, input, cwd, signal, session);
    }

    if (input.action === "create" && category === "backup") {
      return this.executeBackupCreate(input, cwd, owner, signal, session);
    }

    if (input.action === "create") {
      const purpose = input.purpose?.trim();
      if (!purpose || purpose.length > 500 || hasControlCharacters(purpose))
        throw new Error(
          "create requires a purpose (1..500 readable characters).",
        );
      const name =
        input.name ?? (input.kind === "directory" ? "scratch" : "scratch.tmp");
      if (path.basename(name) !== name || name === "." || name === "..")
        throw new Error("name must be one basename, never a path.");
      resolvePath(name, this.root);
      if (input.kind === "directory" && input.content !== undefined)
        throw new Error("Directory temp cannot have content.");
      if ((input.content?.length ?? 0) > 1024 * 1024)
        throw new Error("Initial temp content exceeds 1 MiB characters.");
    }
    const pre =
      input.action === "cleanup" || input.action === "create"
        ? await (async () => {
            const snapshot = await this.readSnapshot();
            if (!snapshot) return undefined;
            return this.preInspectCategory(snapshot, category, signal);
          })()
        : undefined;

    const result = await this.transaction(
      async (state, save) => {
        if (input.action === "policy") {
          const current = state.policies[category];
          let proposed = { ...current, ...input.policy };
          validatePolicy(proposed);
          if (input.execute) {
            if (this.settingsPath)
              proposed = await savePolicy(
                this.settingsPath,
                category,
                rawInput.policy ?? {},
                current,
              );
            state.policies[category] = proposed;
            await save();
          }
          return {
            category,
            root: this.root,
            settingsPath: this.settingsPath ?? null,
            current,
            proposed,
            applied: !!input.execute,
          };
        }
        if (input.action === "list") {
          const offset = input.offset ?? 0;
          const limit = input.limit ?? 100;
          if (
            !Number.isInteger(offset) ||
            offset < 0 ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 200
          )
            throw new Error("List offset/limit invalid (limit 1..200).");
          const scope = input.scope ?? "all";
          const projectKey = pathKey(path.resolve(cwd));
          const items = state.items
            .filter((i) => {
              if (i.category !== category) return false;
              if (scope === "session")
                return (
                  session?.sessionId !== undefined &&
                  i.sessionId === session.sessionId
                );
              if (scope === "project") return pathKey(i.project) === projectKey;
              return true;
            })
            .sort((a, b) => b.createdAt - a.createdAt);
          return {
            root: this.root,
            policy: state.policies[category],
            scope,
            currentSessionId: session?.sessionId ?? null,
            total: items.length,
            items: items.slice(offset, offset + limit),
            nextOffset: offset + limit < items.length ? offset + limit : null,
          };
        }
        if (input.action === "inspect")
          return {
            item: this.find(state, category, input.id),
            root: this.root,
          };
        if (input.action === "pin") {
          if (typeof input.pinned !== "boolean")
            throw new Error("pin requires pinned:true/false.");
          const item = this.find(state, category, input.id);
          if (!["active", "recycled"].includes(item.state))
            throw new Error("Only settled items may be pinned.");
          item.pinned = input.pinned;
          await save();
          return { item };
        }
        if (state.items.some((i) => UNRESOLVED_STATES.includes(i.state)))
          throw new Error(
            "Unresolved managed operation blocks mutation. Use list/inspect; do not reset the registry.",
          );
        checkAbort(signal);
        const activeSessionIds = await readActiveSessions(
          this.root,
          this.now(),
        );
        if (input.action === "cleanup") {
          const failures = await this.applyPreInspection(
            state,
            category,
            pre,
            undefined,
            activeSessionIds,
            signal,
          );
          const plan = planCleanup(
            state,
            category,
            this.now(),
            activeSessionIds,
          );
          if (!input.execute)
            return {
              root: this.root,
              plan,
              applied: false,
              failed: failures,
              status: failures.length ? "partial" : "ok",
            };
          await save();
          return {
            root: this.root,
            applied: true,
            ...(await this.applyCleanup(
              state,
              category,
              save,
              failures,
              activeSessionIds,
            )),
          };
        }
        if (input.action === "touch") {
          const item = this.find(state, category, input.id);
          if (item.state !== "active")
            throw new Error("Only active items may be renewed.");
          await noLinks(item.path);
          if (!(await exists(item.path)))
            throw new Error("Cannot renew a missing managed item.");
          item.expiresAt =
            this.now() +
            (input.ttlHours ?? state.policies[category].ttlHours) * 3600000;
          if (category === "temp") {
            item.owner = owner;
            item.leaseUntil = this.now() + LEASE_MS;
            if (session?.sessionId) item.sessionId = session.sessionId;
          }
          await save();
          return { item };
        }
        if (input.action === "release") {
          const item = this.find(state, category, input.id);
          if (item.state !== "active")
            throw new Error("Only active items may be released.");
          try {
            await this.inspectItem(item, signal, category === "backup");
          } catch (error) {
            checkAbort(signal);
            await save();
            return {
              item,
              applied: false,
              status: "blocked",
              failed: [{ id: item.id, error: errorMessage(error) }],
            };
          }
          if (!input.execute)
            return { item, applied: false, destination: "OS recycle bin" };
          await this.recycle(state, item, save);
          return { item, applied: true };
        }
        if (state.items.length >= MANAGED_LIMITS.registryItems)
          throw new Error(
            `Registry reached ${MANAGED_LIMITS.registryItems} receipts; archive the store before adding items.`,
          );
        const purpose = input.purpose?.trim();
        if (!purpose || purpose.length > 500 || hasControlCharacters(purpose))
          throw new Error(
            "create requires a purpose (1..500 readable characters).",
          );
        const name =
          input.name ??
          (input.kind === "directory" ? "scratch" : "scratch.tmp");
        if (path.basename(name) !== name || name === "." || name === "..")
          throw new Error("name must be one basename, never a path.");
        resolvePath(name, this.root);
        if (input.kind === "directory" && input.content !== undefined)
          throw new Error("Directory temp cannot have content.");
        if ((input.content?.length ?? 0) > 1024 * 1024)
          throw new Error("Initial temp content exceeds 1 MiB characters.");
        const bytes = Buffer.byteLength(input.content ?? "");
        const policy = state.policies[category];
        if (bytes > policy.maxBytes)
          throw new Error("New item exceeds managed byte quota.");
        const failures = await this.applyPreInspection(
          state,
          category,
          pre,
          undefined,
          activeSessionIds,
          signal,
        );
        if (failures.length) {
          await save();
          throw new Error(
            `Cannot admit ${category}: unverified usage for ${failures.map((i) => i.id).join(", ")}. Inspect those items; unknown bytes are not zero.`,
          );
        }
        const id = `${category}-${randomUUID()}`;
        const item: Item = {
          id,
          category,
          name,
          path: path.join(this.root, category, id, name),
          kind: input.kind ?? "file",
          project: path.resolve(cwd),
          purpose,
          owner,
          ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
          ...(session?.sessionFile ? { sessionFile: session.sessionFile } : {}),
          pid: process.pid,
          host: hostname(),
          createdAt: this.now(),
          expiresAt: this.now() + (input.ttlHours ?? policy.ttlHours) * 3600000,
          leaseUntil: this.now() + LEASE_MS,
          pinned: input.pinned ?? false,
          bytes,
          lastVerifiedAt: this.now(),
          state: "creating",
        };
        // Forecast eviction before writing new content. The proposed item is never itself evicted.
        const forecast: StoreState = {
          ...state,
          items: [...state.items, { ...item, state: "active", pinned: true }],
        };
        const plan = planCleanup(
          forecast,
          category,
          this.now(),
          activeSessionIds,
        );
        if (plan.overBudget)
          throw new Error(
            "Quota cannot admit this item while pins/leases or recovery-window bytes are protected. Release items or increase policy.",
          );
        for (const row of plan.recycle)
          await this.recycle(state, this.find(state, category, row.id), save);
        const itemDir = path.dirname(item.path);
        await mkdir(itemDir, { mode: 0o700 });
        try {
          if (item.kind === "directory")
            await mkdir(item.path, { mode: 0o700 });
          else
            await writeFile(item.path, input.content ?? "", {
              flag: "wx",
              mode: 0o600,
            });
          item.state = "active";
          state.items.push(item);
          await save();
          return {
            item,
            root: this.root,
            evicted: plan.recycle.map((i) => i.id),
            policy,
          };
        } catch (error) {
          await rm(itemDir, { recursive: true, force: true }).catch(
            () => undefined,
          );
          throw new Error(`Managed creation failed: ${errorMessage(error)}`);
        }
      },
      true,
      {
        operation: `${category}:${input.action}`,
        signal,
        sessionId: session?.sessionId,
      },
    );
    if (session?.sessionId)
      await touchSession(this.root, { ...session, cwd }, this.now()).catch(
        () => undefined,
      );
    return result as OperationResult;
  }
  private async executeBackupCreate(
    input: NormalizedInput,
    cwd: string,
    owner: string,
    signal?: AbortSignal,
    session?: SessionIdentity,
  ): Promise<OperationResult> {
    const settings = this.settings();
    const purpose = input.purpose?.trim();
    if (!purpose || purpose.length > 500 || hasControlCharacters(purpose))
      throw new Error(
        "create requires a purpose (1..500 readable characters).",
      );
    const originalPath = resolvePath(input.path, cwd);
    if (pathKey(originalPath) === pathKey(path.parse(originalPath).root))
      throw new Error("Refusing to snapshot a filesystem root.");
    await this.outside(originalPath);
    const name = path.basename(originalPath);
    if (path.basename(name) !== name || name === "." || name === "..")
      throw new Error("name must be one basename, never a path.");
    resolvePath(name, this.root);

    // Ensure store exists before staging inside <root>/.staging.
    if (!(await exists(path.join(this.root, marker))))
      await this.transaction(async () => undefined, true, {
        operation: "backup:init",
        signal,
        sessionId: session?.sessionId,
      });

    const snapshot = await this.readSnapshot();
    const initialPolicy = snapshot?.policies.backup ?? {
      ...DEFAULT_POLICIES.backup,
      ...settings.policies?.backup,
    };
    const stagingRoot = path.join(this.root, ".staging");
    await noLinks(stagingRoot);
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const stagingId = randomUUID();
    const stagingDir = path.join(stagingRoot, stagingId);
    const metaPath = path.join(stagingRoot, `${stagingId}.meta.json`);
    const meta: StagingMeta = {
      pid: process.pid,
      processInstanceId: CURRENT_PROCESS_INSTANCE_ID,
      hostname: hostname(),
      startedAtMs: Date.now(),
    };
    await writeFile(metaPath, JSON.stringify(meta), {
      flag: "wx",
      mode: 0o600,
    });
    await mkdir(stagingDir, { mode: 0o700 });
    const stagedPayload = path.join(stagingDir, name);

    try {
      let sourceTree!: Tree;
      let copied!: Tree;
      await locked(
        [originalPath],
        async () => {
          sourceTree = await inspectTree(
            originalPath,
            initialPolicy.maxBytes,
            signal,
            "reject",
            true,
          );
          await copyTree(originalPath, stagedPayload, sourceTree, signal);
          copied = await inspectTree(
            stagedPayload,
            initialPolicy.maxBytes,
            signal,
            "reject",
            true,
          );
          const after = await inspectTree(
            originalPath,
            initialPolicy.maxBytes,
            signal,
            "reject",
            true,
          );
          if (
            copied.digest !== sourceTree.digest ||
            after.digest !== sourceTree.digest
          )
            throw new Error(
              "Source changed or backup verification failed; partial payload retained.",
            );
        },
        signal,
      );

      const preSnapshot = await this.readSnapshot();
      const pre = preSnapshot
        ? await this.preInspectCategory(preSnapshot, "backup", signal)
        : undefined;

      const committed = await this.transaction(
        async (state, save) => {
          if (state.items.some((i) => UNRESOLVED_STATES.includes(i.state)))
            throw new Error(
              "Unresolved managed operation blocks mutation. Use list/inspect; do not reset the registry.",
            );
          if (state.items.length >= MANAGED_LIMITS.registryItems)
            throw new Error(
              `Registry reached ${MANAGED_LIMITS.registryItems} receipts; archive the store before adding items.`,
            );
          const policy = state.policies.backup;
          if (copied.bytes > policy.maxBytes)
            throw new Error("New item exceeds managed byte quota.");
          const activeSessionIds = await readActiveSessions(
            this.root,
            this.now(),
          );
          const failures = await this.applyPreInspection(
            state,
            "backup",
            pre,
            undefined,
            activeSessionIds,
            signal,
          );
          if (failures.length) {
            await save();
            throw new Error(
              `Cannot admit backup: unverified usage for ${failures.map((i) => i.id).join(", ")}. Inspect those items; unknown bytes are not zero.`,
            );
          }
          const id = `backup-${randomUUID()}`;
          const item: Item = {
            id,
            category: "backup",
            name,
            path: path.join(this.root, "backup", id, name),
            kind: sourceTree.kind,
            originalPath,
            project: path.resolve(cwd),
            purpose,
            owner,
            ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
            ...(session?.sessionFile
              ? { sessionFile: session.sessionFile }
              : {}),
            pid: process.pid,
            host: hostname(),
            createdAt: this.now(),
            expiresAt:
              this.now() + (input.ttlHours ?? policy.ttlHours) * 3600000,
            leaseUntil: 0,
            pinned: input.pinned ?? false,
            bytes: copied.bytes,
            digest: copied.digest,
            linkCount: copied.linkCount,
            lastVerifiedAt: this.now(),
            state: "active",
          };
          const forecast: StoreState = {
            ...state,
            items: [...state.items, { ...item, state: "active", pinned: true }],
          };
          const plan = planCleanup(
            forecast,
            "backup",
            this.now(),
            activeSessionIds,
          );
          if (plan.overBudget)
            throw new Error(
              "Quota cannot admit this item while pins/leases or recovery-window bytes are protected. Release items or increase policy.",
            );
          for (const row of plan.recycle)
            await this.recycle(state, this.find(state, "backup", row.id), save);
          const itemDir = path.dirname(item.path);
          await mkdir(itemDir, { mode: 0o700 });
          try {
            await rename(stagedPayload, item.path);
          } catch (error) {
            await rmdir(itemDir).catch(() => undefined);
            throw error;
          }
          state.items.push(item);
          try {
            await save();
          } catch (error) {
            await rename(item.path, stagedPayload).catch(() => undefined);
            await rmdir(itemDir).catch(() => undefined);
            throw error;
          }
          return {
            item,
            root: this.root,
            evicted: plan.recycle.map((i) => i.id),
            policy,
          };
        },
        true,
        {
          operation: "backup:create",
          signal,
          sessionId: session?.sessionId,
        },
      );
      if (session?.sessionId)
        await touchSession(this.root, { ...session, cwd }, this.now()).catch(
          () => undefined,
        );
      return committed as OperationResult;
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
      await rm(metaPath, { force: true }).catch(() => undefined);
    }
  }
  private async executeRestore(
    category: Category,
    input: NormalizedInput,
    cwd: string,
    signal?: AbortSignal,
    session?: SessionIdentity,
  ): Promise<OperationResult> {
    const settings = this.settings();
    const snapshot = await this.readSnapshot();
    if (!snapshot) {
      // Initialize or fail cleanly inside transaction if store doesn't exist yet.
      await this.transaction(
        async (state) => {
          this.find(state, category, input.id);
        },
        true,
        {
          operation: `${category}:restore:check`,
          signal,
          sessionId: session?.sessionId,
        },
      );
    } else {
      this.find(snapshot, category, input.id);
    }

    const itemId = input.id as string;
    let itemLock: LockHandle | undefined;
    try {
      itemLock = await acquireFileLock({
        lockPath: this.itemLockPath(itemId),
        operation: `${category}:restore`,
        waitMs: this.lockWaitMs(settings),
        sessionId: session?.sessionId,
        signal,
        autoReclaimStale: this.autoReclaimStale(settings),
        busyMessage: (lockPath, owner) =>
          `Managed item ${itemId} is busy: ${formatLockDiagnostics(lockPath, owner)}`,
      });

      const prep = (await this.transaction(
        async (state, save) => {
          if (state.items.some((i) => UNRESOLVED_STATES.includes(i.state)))
            throw new Error(
              "Unresolved managed operation blocks mutation. Use list/inspect; do not reset the registry.",
            );
          const item = this.find(state, category, itemId);
          if (!["active", "recycled"].includes(item.state))
            throw new Error("Item cannot be restored in this state.");
          const destination = resolvePath(
            input.destination ?? item.originalPath,
            cwd,
          );
          await this.outside(destination);
          if (await exists(destination))
            throw new Error(
              "Restore destination already exists; choose another path.",
            );
          if (item.state === "active") {
            return {
              item: structuredClone(item),
              destination,
              recoveredFromBin: false,
            };
          }
          const bin = (await this.trash.list()).find(
            (i) => i.id === item.trashId,
          );
          if (!bin || pathKey(bin.originalPath) !== pathKey(item.path))
            throw new Error("Recycled identity changed; no restore attempted.");
          // Recover into the registered path first, never trust unchecked OS-bin contents as a backup.
          item.state = "creating";
          await save();
          const recovery = await this.trash.restore(
            item.trashId as string,
            item.path,
          );
          if (
            pathKey(recovery.destination) !== pathKey(item.path) ||
            !(await exists(item.path))
          )
            throw new Error(
              "Restore outcome differs from its registered path; inspect source and OS bin before retry.",
            );
          item.state = "active";
          delete item.trashId;
          delete item.recycledAt;
          item.expiresAt =
            this.now() + state.policies[category].ttlHours * 3600000;
          item.inspectionError = "Recovered item awaits inspection.";
          await save();
          return {
            item: structuredClone(item),
            destination,
            recoveredFromBin: true,
          };
        },
        true,
        {
          operation: `${category}:restore:prepare`,
          signal,
          sessionId: session?.sessionId,
        },
      )) as { item: Item; destination: string; recoveredFromBin: boolean };

      // Inspect and copy out outside the global store lock while holding the per-item lock.
      let tree: Tree;
      try {
        await noLinks(prep.item.path);
        tree = await inspectTree(
          prep.item.path,
          MANAGED_LIMITS.maxBytes,
          signal,
          category === "temp" ? "opaque" : "reject",
          true,
        );
        if (category === "backup" && tree.digest !== prep.item.digest)
          throw new Error(
            `Backup integrity check failed: ${prep.item.id}; no cleanup performed.`,
          );
      } catch (error) {
        checkAbort(signal);
        const msg = errorMessage(error).slice(0, 2000);
        const blockedItem = (await this.transaction(
          async (state, save) => {
            const current = this.find(state, category, prep.item.id);
            current.inspectionError = msg;
            await save();
            return structuredClone(current);
          },
          false,
          {
            operation: `${category}:restore:record-error`,
            signal,
            sessionId: session?.sessionId,
          },
        )) as Item;
        return {
          item: blockedItem,
          applied: false,
          ...(prep.recoveredFromBin
            ? {
                recoveredToManagedPath: true,
                recoveredPath: prep.item.path,
                destinationRequested: prep.destination,
              }
            : {}),
          status: "blocked",
          failed: [{ id: prep.item.id, error: msg }],
        };
      }

      const verifiedItem = (await this.transaction(
        async (state, save) => {
          const current = this.find(state, category, prep.item.id);
          current.bytes = tree.bytes;
          current.linkCount = tree.linkCount;
          current.lastVerifiedAt = this.now();
          delete current.inspectionError;
          await save();
          return structuredClone(current);
        },
        false,
        {
          operation: `${category}:restore:verify`,
          signal,
          sessionId: session?.sessionId,
        },
      )) as Item;

      await this.copyOut(verifiedItem, tree, prep.destination, cwd, signal);
      return {
        item: verifiedItem,
        destination: prep.destination,
        verifiedDigest: tree.digest,
        consumed: false,
      };
    } finally {
      await itemLock?.release();
    }
  }
}
