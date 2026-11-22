import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathKey } from "../paths.js";
import { checkAbort, errorMessage } from "../types.js";

/** Unique per Node process lifetime so PID reuse after a crash is detectable. */
export const CURRENT_PROCESS_INSTANCE_ID = randomUUID();

export interface LockOwner {
  pid: number;
  processInstanceId: string;
  hostname: string;
  operation: string;
  startedAt: string;
  startedAtMs: number;
  sessionId?: string;
}

export interface LockHandle {
  readonly lockPath: string;
  readonly owner: LockOwner;
  release(): Promise<void>;
}

export interface LockOptions {
  lockPath: string;
  operation: string;
  waitMs: number;
  sessionId?: string;
  signal?: AbortSignal;
  staleGraceMs?: number;
  autoReclaimStale?: boolean;
  canReclaimStale?: (
    owner?: LockOwner,
  ) => Promise<{ ok: boolean; reason?: string }>;
  onStaleReclaimed?: (info: {
    lockPath: string;
    owner?: LockOwner;
    reason: string;
  }) => void;
  busyMessage?: (lockPath: string, owner?: LockOwner) => string;
}

const inProcessQueues = new Map<string, Promise<void>>();
const inProcessHolders = new Set<string>();

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export async function readLockOwner(
  lockPath: string,
): Promise<LockOwner | undefined> {
  try {
    const ownerFile = path.join(lockPath, "owner.json");
    const info = await lstat(ownerFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024)
      return undefined;
    const parsed = JSON.parse(
      await readFile(ownerFile, "utf8"),
    ) as Partial<LockOwner>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.processInstanceId !== "string" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.operation !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.startedAtMs !== "number"
    )
      return undefined;
    return parsed as LockOwner;
  } catch {
    return undefined;
  }
}

export function isOwnerProvablyDead(
  owner: LockOwner,
  now = Date.now(),
  staleGraceMs = 5000,
): { dead: boolean; reason: string } {
  if (owner.hostname !== hostname())
    return { dead: false, reason: `remote-host:${owner.hostname}` };
  if (now - owner.startedAtMs < staleGraceMs)
    return { dead: false, reason: "within-grace-window" };
  if (
    owner.pid === process.pid &&
    owner.processInstanceId !== CURRENT_PROCESS_INSTANCE_ID
  )
    return { dead: true, reason: "pid-reused-by-current-process" };
  if (!isPidAlive(owner.pid))
    return { dead: true, reason: `pid-${owner.pid}-not-running` };
  return { dead: false, reason: `pid-${owner.pid}-alive` };
}

export function formatLockDiagnostics(
  lockPath: string,
  owner?: LockOwner,
): string {
  if (!owner) return `${lockPath} (owner metadata unavailable)`;
  const ageMs = Math.max(0, Date.now() - owner.startedAtMs);
  const status =
    owner.hostname !== hostname()
      ? `remote-host:${owner.hostname}`
      : owner.pid === process.pid &&
          owner.processInstanceId !== CURRENT_PROCESS_INSTANCE_ID
        ? "dead-pid-reused"
        : isPidAlive(owner.pid)
          ? "alive"
          : "dead";
  const sessionPart = owner.sessionId ? `, session=${owner.sessionId}` : "";
  return `${lockPath} (pid=${owner.pid} [${status}], op=${owner.operation}, startedAt=${owner.startedAt}, ageMs=${ageMs}${sessionPart})`;
}

async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await rmdir(dir);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (
        attempt < 3 &&
        (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY")
      ) {
        await delay(25);
        continue;
      }
      throw error;
    }
  }
}

async function cleanupLockDir(lockDir: string): Promise<void> {
  try {
    await unlink(path.join(lockDir, "owner.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await removeDirWithRetry(lockDir);
}

async function tryReclaimStaleLock(
  options: LockOptions,
  staleGraceMs: number,
): Promise<{ reclaimed: boolean; owner?: LockOwner; blockedReason?: string }> {
  const { lockPath } = options;
  let info;
  try {
    info = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { reclaimed: true };
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`Refusing non-directory or symlink lock path: ${lockPath}`);
  const owner = await readLockOwner(lockPath);
  if (!options.autoReclaimStale) return { reclaimed: false, owner };

  let deadReason: string | undefined;
  if (owner) {
    const check = isOwnerProvablyDead(owner, Date.now(), staleGraceMs);
    if (!check.dead) return { reclaimed: false, owner };
    deadReason = check.reason;
  } else {
    let entries: string[];
    try {
      entries = await readdir(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { reclaimed: true };
      throw error;
    }
    if (entries.length === 0 && Date.now() - info.mtimeMs >= staleGraceMs)
      deadReason = "empty-lock-without-owner-past-grace";
    else return { reclaimed: false, owner };
  }

  if (options.canReclaimStale) {
    const allowed = await options.canReclaimStale(owner);
    if (!allowed.ok)
      return {
        reclaimed: false,
        owner,
        blockedReason: allowed.reason ?? "stale lock reclaim refused",
      };
  }

  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { reclaimed: true, owner };
    if (code === "EEXIST" || code === "EPERM" || code === "EBUSY")
      return { reclaimed: false, owner };
    throw error;
  }
  try {
    await cleanupLockDir(stalePath);
  } catch {
    // Best-effort cleanup of renamed stale directory; original lock path is already freed.
  }
  options.onStaleReclaimed?.({ lockPath, owner, reason: deadReason });
  return { reclaimed: true, owner };
}

async function acquireInProcessSlot(
  key: string,
  deadline: number,
  waitMs: number,
  signal?: AbortSignal,
): Promise<(() => void) | undefined> {
  if (waitMs === 0 && inProcessHolders.has(key)) return undefined;
  for (;;) {
    checkAbort(signal);
    const current = inProcessQueues.get(key);
    if (!current && !inProcessHolders.has(key)) break;
    if (waitMs === 0 || Date.now() >= deadline) return undefined;
    const remaining = Math.max(1, deadline - Date.now());
    await Promise.race([
      current ?? Promise.resolve(),
      delay(
        Math.min(remaining, 50),
        undefined,
        signal ? { signal } : undefined,
      ).catch((err) => {
        if (signal?.aborted) checkAbort(signal);
        throw err;
      }),
    ]);
  }
  let releaseSlot!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSlot = resolve;
  });
  inProcessHolders.add(key);
  inProcessQueues.set(key, gate);
  return () => {
    inProcessHolders.delete(key);
    if (inProcessQueues.get(key) === gate) inProcessQueues.delete(key);
    releaseSlot();
  };
}

export async function tryAcquireFileLock(
  options: LockOptions,
): Promise<
  | { acquired: true; handle: LockHandle }
  | { acquired: false; reason: string; owner?: LockOwner }
> {
  checkAbort(options.signal);
  const resolvedLock = path.resolve(options.lockPath);
  const key = pathKey(resolvedLock);
  const deadline = Date.now() + Math.max(0, options.waitMs);
  const staleGraceMs = options.staleGraceMs ?? 5000;

  const releaseSlot = await acquireInProcessSlot(
    key,
    deadline,
    options.waitMs,
    options.signal,
  );
  if (!releaseSlot) {
    const owner = await readLockOwner(resolvedLock);
    return { acquired: false, reason: "busy-in-process", owner };
  }

  const owner: LockOwner = {
    pid: process.pid,
    processInstanceId: CURRENT_PROCESS_INSTANCE_ID,
    hostname: hostname(),
    operation: options.operation,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  };
  const parent = path.dirname(resolvedLock);
  const tempOwner = path.join(parent, `.lock-owner-${randomUUID()}.tmp`);
  let tempPrepared = false;
  let lockCreated = false;
  let handedOff = false;

  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const file = await open(tempOwner, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(owner));
    } finally {
      await file.close();
    }
    tempPrepared = true;

    for (;;) {
      checkAbort(options.signal);
      try {
        await mkdir(resolvedLock, { mode: 0o700 });
        lockCreated = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stale = await tryReclaimStaleLock(options, staleGraceMs);
        if (stale.blockedReason) {
          throw new Error(
            `Stale lock detected at ${formatLockDiagnostics(resolvedLock, stale.owner)}, but auto-reclaim was refused: ${stale.blockedReason}`,
          );
        }
        if (stale.reclaimed) continue;
        if (options.waitMs === 0 || Date.now() >= deadline) {
          return {
            acquired: false,
            reason: "busy-cross-process",
            owner: stale.owner,
          };
        }
        await delay(
          Math.min(25, Math.max(1, deadline - Date.now())),
          undefined,
          options.signal ? { signal: options.signal } : undefined,
        ).catch((err) => {
          if (options.signal?.aborted) checkAbort(options.signal);
          throw err;
        });
      }
    }

    await rename(tempOwner, path.join(resolvedLock, "owner.json"));
    tempPrepared = false;

    let released = false;
    handedOff = true;
    return {
      acquired: true,
      handle: {
        lockPath: resolvedLock,
        owner,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await cleanupLockDir(resolvedLock);
          } finally {
            releaseSlot();
          }
        },
      },
    };
  } finally {
    if (!handedOff) {
      if (lockCreated) {
        try {
          await cleanupLockDir(resolvedLock);
        } catch {
          // Preserve original acquisition error or busy result.
        }
      }
      if (tempPrepared) {
        try {
          await unlink(tempOwner);
        } catch {
          // Ignore temp cleanup failure.
        }
      }
      releaseSlot();
    }
  }
}

export async function acquireFileLock(
  options: LockOptions,
): Promise<LockHandle> {
  const attempt = await tryAcquireFileLock(options);
  if (attempt.acquired) return attempt.handle;
  const message = options.busyMessage
    ? options.busyMessage(options.lockPath, attempt.owner)
    : `Lock busy: ${formatLockDiagnostics(options.lockPath, attempt.owner)}`;
  throw new Error(message);
}

export async function withFileLock<T>(
  options: LockOptions,
  fn: (handle: LockHandle) => Promise<T>,
): Promise<T> {
  const handle = await acquireFileLock(options);
  let result!: T;
  let primaryError: unknown;
  let hasError = false;
  try {
    result = await fn(handle);
  } catch (error) {
    primaryError = error;
    hasError = true;
  }
  try {
    await handle.release();
  } catch (releaseError) {
    if (!hasError) throw releaseError;
    console.error(
      `[pi-file-tools] lock release failed after error (${errorMessage(releaseError)})`,
    );
  }
  if (hasError) throw primaryError;
  return result;
}

export async function tryWithFileLock<T>(
  options: LockOptions,
  fn: (handle: LockHandle) => Promise<T>,
): Promise<
  | { acquired: true; value: T }
  | { acquired: false; reason: string; owner?: LockOwner }
> {
  const attempt = await tryAcquireFileLock(options);
  if (!attempt.acquired) return attempt;
  let value!: T;
  let primaryError: unknown;
  let hasError = false;
  try {
    value = await fn(attempt.handle);
  } catch (error) {
    primaryError = error;
    hasError = true;
  }
  try {
    await attempt.handle.release();
  } catch (releaseError) {
    if (!hasError) throw releaseError;
    console.error(
      `[pi-file-tools] lock release failed after error (${errorMessage(releaseError)})`,
    );
  }
  if (hasError) throw primaryError;
  return { acquired: true, value };
}
