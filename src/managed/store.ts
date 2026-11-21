import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  writeFile,
} from "node:fs/promises";
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

export class ManagedStore {
  readonly root: string;
  readonly settingsPath: string | undefined;
  private readonly rootOverride: string | undefined;
  private readonly now: () => number;
  private readonly files: FileOperations;
  private readonly lockWaitMs: number;
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
    this.lockWaitMs = options.lockWaitMs ?? 2000;
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
  private async transaction<T>(
    fn: (state: StoreState, save: () => Promise<void>) => Promise<T>,
    initialize = true,
  ): Promise<T | undefined> {
    const settings = this.settings();
    if (!(await exists(this.root))) {
      if (!initialize) return undefined;
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
    const lock = path.join(this.root, ".lock");
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `Managed store is locked: ${lock}. Never auto-remove a possibly live lock; inspect other Pi sessions first.`,
          );
        await delay(25);
      }
    }
    try {
      await writeFile(
        path.join(lock, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
        { flag: "wx", mode: 0o600 },
      );
      const markerPath = path.join(this.root, marker);
      const statePath = path.join(this.root, "state.json");
      if (!(await exists(markerPath))) {
        if ((await readdir(this.root)).some((name) => name !== ".lock"))
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
      const save = () => this.atomic(statePath, state);
      return await fn(state, save);
    } finally {
      // Only remove this transaction's lock metadata, never user payloads.
      const { unlink } = await import("node:fs/promises");
      if (await exists(path.join(lock, "owner.json")))
        await unlink(path.join(lock, "owner.json"));
      await rmdir(lock);
    }
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
          (!Number.isSafeInteger(item.linkCount) || item.linkCount < 0))
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
  private async inspectItem(item: Item, signal?: AbortSignal): Promise<Tree> {
    try {
      await noLinks(item.path);
      const tree = await inspectTree(
        item.path,
        MANAGED_LIMITS.maxBytes,
        signal,
        item.category === "temp" ? "opaque" : "reject",
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
  private async refresh(
    state: StoreState,
    category: Category,
    owner?: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; error: string }[]> {
    const failed: { id: string; error: string }[] = [];
    const now = this.now();
    for (const item of state.items.filter(
      (i) => i.state === "active" && i.category === category,
    )) {
      try {
        await this.inspectItem(item, signal);
        if (
          item.category === "temp" &&
          owner &&
          item.owner === owner &&
          item.leaseUntil > now
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
      (await inspectTree(destination, MANAGED_LIMITS.maxBytes, signal, links))
        .digest !== tree.digest
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
      list: ["offset", "limit"],
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
    state: StoreState,
    item: Item,
    save: () => Promise<void>,
  ): Promise<void> {
    await this.inspectItem(item);
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
    } catch (error) {
      item.error = `Recycle outcome may be uncertain; inspect source and OS bin before retry: ${errorMessage(error)}`;
      await save();
      throw error;
    }
  }
  private async applyCleanup(
    state: StoreState,
    category: Category,
    save: () => Promise<void>,
    inspectionFailures: { id: string; error: string }[] = [],
  ): Promise<OperationResult> {
    const plan = planCleanup(state, category, this.now());
    const released: string[] = [];
    const purged: string[] = [];
    const failed: { id: string; error: string }[] = [...inspectionFailures];
    // Validate every selected OS id against its original registered path before any purge.
    const bin = plan.purge.length ? await this.trash.list() : [];
    for (const row of plan.purge) {
      const item = this.find(state, category, row.id);
      const match = bin.find((i) => i.id === item.trashId);
      if (!match || pathKey(match.originalPath) !== pathKey(item.path))
        throw new Error(
          `OS bin identity mismatch for ${item.id}; no purge performed.`,
        );
    }
    for (const row of plan.recycle) {
      const item = this.find(state, category, row.id);
      try {
        await this.recycle(state, item, save);
        released.push(item.id);
      } catch (error) {
        failed.push({ id: item.id, error: errorMessage(error) });
        if (item.state !== "active") break;
        await save();
      }
    }
    for (const row of plan.purge) {
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
  async maintain(owner?: string): Promise<OperationResult> {
    const result = await this.transaction(async (state, save) => {
      const unresolved = state.items.filter(
        (i) => !["active", "recycled", "purged"].includes(i.state),
      );
      if (unresolved.length)
        throw new Error(
          `Unresolved managed operations: ${unresolved.map((i) => i.id).join(", ")}; preserve evidence and inspect before maintenance.`,
        );
      const backupFailures = await this.refresh(state, "backup", owner);
      const tempFailures = await this.refresh(state, "temp", owner);
      await save();
      const backup = await this.applyCleanup(
        state,
        "backup",
        save,
        backupFailures,
      );
      const temp = await this.applyCleanup(state, "temp", save, tempFailures);
      state.lastSweep = this.now();
      await save();
      const failed = [
        ...(backup.failed as unknown[]),
        ...(temp.failed as unknown[]),
      ];
      return {
        root: this.root,
        status: failed.length ? "partial" : "ok",
        failed,
        backup,
        temp,
      };
    }, false);
    return result ?? { root: this.root, initialized: false };
  }
  async execute(
    category: Category,
    rawInput: ManagedInput,
    cwd: string,
    owner = "manual",
    signal?: AbortSignal,
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
    const result = await this.transaction(async (state, save) => {
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
        const items = state.items
          .filter((i) => i.category === category)
          .sort((a, b) => b.createdAt - a.createdAt);
        return {
          root: this.root,
          policy: state.policies[category],
          total: items.length,
          items: items.slice(offset, offset + limit),
          nextOffset: offset + limit < items.length ? offset + limit : null,
        };
      }
      if (input.action === "inspect")
        return { item: this.find(state, category, input.id), root: this.root };
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
      if (
        state.items.some(
          (i) => !["active", "recycled", "purged"].includes(i.state),
        )
      )
        throw new Error(
          "Unresolved managed operation blocks mutation. Use list/inspect; do not reset the registry.",
        );
      checkAbort(signal);
      if (input.action === "cleanup") {
        const failures = await this.refresh(state, category, undefined, signal);
        const plan = planCleanup(state, category, this.now());
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
          ...(await this.applyCleanup(state, category, save, failures)),
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
        }
        await save();
        return { item };
      }
      if (input.action === "release") {
        const item = this.find(state, category, input.id);
        if (item.state !== "active")
          throw new Error("Only active items may be released.");
        if (item.pinned) throw new Error("Unpin the item before releasing it.");
        try {
          await this.inspectItem(item, signal);
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
        checkAbort(signal);
        await this.recycle(state, item, save);
        return { item, applied: true };
      }
      if (input.action === "restore") {
        const item = this.find(state, category, input.id);
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
          let tree: Tree;
          try {
            tree = await this.inspectItem(item, signal);
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
          await this.copyOut(item, tree, destination, cwd, signal);
          await save();
          return {
            item,
            destination,
            verifiedDigest: tree.digest,
            consumed: false,
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
        let tree: Tree;
        try {
          tree = await this.inspectItem(item, signal);
        } catch (error) {
          checkAbort(signal);
          await save();
          return {
            item,
            applied: false,
            recoveredToManagedPath: true,
            recoveredPath: item.path,
            destinationRequested: destination,
            status: "blocked",
            failed: [{ id: item.id, error: errorMessage(error) }],
          };
        }
        await save();
        await this.copyOut(item, tree, destination, cwd, signal);
        return {
          item,
          destination,
          verifiedDigest: tree.digest,
          consumed: false,
        };
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
      let originalPath: string | undefined;
      let sourceTree: Awaited<ReturnType<typeof inspectTree>> | undefined;
      let name =
        input.name ?? (input.kind === "directory" ? "scratch" : "scratch.tmp");
      if (category === "backup") {
        originalPath = resolvePath(input.path, cwd);
        if (pathKey(originalPath) === pathKey(path.parse(originalPath).root))
          throw new Error("Refusing to snapshot a filesystem root.");
        await this.outside(originalPath);
        sourceTree = await inspectTree(
          originalPath,
          state.policies[category].maxBytes,
          signal,
        );
        name = path.basename(originalPath);
      }
      if (path.basename(name) !== name || name === "." || name === "..")
        throw new Error("name must be one basename, never a path.");
      resolvePath(name, this.root);
      if (
        category === "temp" &&
        input.kind === "directory" &&
        input.content !== undefined
      )
        throw new Error("Directory temp cannot have content.");
      if ((input.content?.length ?? 0) > 1024 * 1024)
        throw new Error("Initial temp content exceeds 1 MiB characters.");
      const bytes = sourceTree?.bytes ?? Buffer.byteLength(input.content ?? "");
      const policy = state.policies[category];
      if (bytes > policy.maxBytes)
        throw new Error("New item exceeds managed byte quota.");
      const failures = await this.refresh(state, category, undefined, signal);
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
        kind: sourceTree?.kind ?? input.kind ?? "file",
        ...(originalPath ? { originalPath } : {}),
        project: path.resolve(cwd),
        purpose,
        owner,
        createdAt: this.now(),
        expiresAt: this.now() + (input.ttlHours ?? policy.ttlHours) * 3600000,
        leaseUntil: category === "temp" ? this.now() + LEASE_MS : 0,
        pinned: input.pinned ?? false,
        bytes,
        state: "creating",
      };
      // Forecast eviction before writing new content. The proposed item is never itself evicted.
      const forecast: StoreState = {
        ...state,
        items: [...state.items, { ...item, state: "active", pinned: true }],
      };
      const plan = planCleanup(forecast, category, this.now());
      if (plan.overBudget)
        throw new Error(
          "Quota cannot admit this item while pins/leases or recovery-window bytes are protected. Release items or increase policy.",
        );
      for (const row of plan.recycle)
        await this.recycle(state, this.find(state, category, row.id), save);
      state.items.push(item);
      await save();
      await mkdir(path.dirname(item.path), { mode: 0o700 });
      try {
        if (originalPath && sourceTree) {
          await locked(
            [originalPath],
            async () => {
              await copyTree(
                originalPath as string,
                item.path,
                sourceTree as NonNullable<typeof sourceTree>,
                signal,
              );
              const copied = await inspectTree(
                item.path,
                policy.maxBytes,
                signal,
              );
              const after = await inspectTree(
                originalPath as string,
                policy.maxBytes,
                signal,
              );
              if (
                copied.digest !== sourceTree?.digest ||
                after.digest !== sourceTree?.digest
              )
                throw new Error(
                  "Source changed or backup verification failed; partial payload retained.",
                );
              item.digest = copied.digest;
            },
            signal,
          );
        } else if (item.kind === "directory")
          await mkdir(item.path, { mode: 0o700 });
        else
          await writeFile(item.path, input.content ?? "", {
            flag: "wx",
            mode: 0o600,
          });
        item.state = "active";
        await save();
        return {
          item,
          root: this.root,
          evicted: plan.recycle.map((i) => i.id),
          policy,
        };
      } catch (error) {
        item.state = "failed";
        item.error = errorMessage(error);
        await save();
        throw new Error(
          `Managed creation failed; retained ${item.id} for inspection: ${item.error}`,
        );
      }
    });
    return result as OperationResult;
  }
}
