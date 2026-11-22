import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { exists } from "../paths.js";
import { CURRENT_PROCESS_INSTANCE_ID, isPidAlive } from "./locks.js";
import { noLinks } from "./tree.js";

export const SESSION_HEARTBEAT_TTL_MS = 20 * 60 * 1000;

export interface SessionIdentity {
  sessionId?: string;
  sessionFile?: string;
  sessionName?: string;
  cwd?: string;
}

export interface SessionRecord {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  cwd: string;
  pid: number;
  processInstanceId: string;
  hostname: string;
  startedAt: number;
  lastSeenAt: number;
}

function sessionFileName(sessionId: string): string {
  const safe = /^[A-Za-z0-9_-]{1,80}$/u.test(sessionId)
    ? sessionId
    : createHash("sha256").update(sessionId).digest("hex");
  return `${safe}.json`;
}

export function sessionsDir(root: string): string {
  return path.join(root, "sessions");
}

export async function touchSession(
  root: string,
  session: SessionIdentity | undefined,
  now = Date.now(),
): Promise<void> {
  if (!session?.sessionId) return;
  const markerPath = path.join(root, ".pi-file-tools-store");
  if (!(await exists(markerPath))) return;
  const dir = sessionsDir(root);
  await noLinks(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, sessionFileName(session.sessionId));
  await noLinks(target);
  let startedAt = now;
  try {
    const existing = JSON.parse(
      await readFile(target, "utf8"),
    ) as Partial<SessionRecord>;
    if (
      existing.processInstanceId === CURRENT_PROCESS_INSTANCE_ID &&
      typeof existing.startedAt === "number"
    )
      startedAt = existing.startedAt;
  } catch {
    // New or unreadable session record starts fresh.
  }
  const record: SessionRecord = {
    sessionId: session.sessionId,
    ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
    ...(session.sessionName ? { sessionName: session.sessionName } : {}),
    cwd: session.cwd ?? process.cwd(),
    pid: process.pid,
    processInstanceId: CURRENT_PROCESS_INSTANCE_ID,
    hostname: hostname(),
    startedAt,
    lastSeenAt: now,
  };
  const temp = path.join(dir, `.session-${randomUUID()}.tmp`);
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(record)}\n`);
  } finally {
    await file.close();
  }
  await rename(temp, target);
}

export async function removeSession(
  root: string,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  const target = path.join(sessionsDir(root), sessionFileName(sessionId));
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) return;
    const existing = JSON.parse(
      await readFile(target, "utf8"),
    ) as Partial<SessionRecord>;
    if (
      existing.processInstanceId === CURRENT_PROCESS_INSTANCE_ID ||
      (existing.hostname === hostname() &&
        typeof existing.pid === "number" &&
        !isPidAlive(existing.pid))
    )
      await unlink(target);
  } catch {
    // Best-effort cleanup on shutdown.
  }
}

export async function readActiveSessions(
  root: string,
  now = Date.now(),
  ttlMs = SESSION_HEARTBEAT_TTL_MS,
): Promise<Set<string>> {
  const active = new Set<string>();
  const dir = sessionsDir(root);
  if (!(await exists(dir))) return active;
  await noLinks(dir);
  const entries = await readdir(dir);
  const host = hostname();
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const file = path.join(dir, name);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024)
        continue;
      const record = JSON.parse(
        await readFile(file, "utf8"),
      ) as Partial<SessionRecord>;
      if (
        typeof record.sessionId !== "string" ||
        typeof record.pid !== "number" ||
        typeof record.processInstanceId !== "string" ||
        typeof record.hostname !== "string" ||
        typeof record.lastSeenAt !== "number"
      )
        continue;
      const expired = now - record.lastSeenAt > ttlMs;
      const deadLocal =
        record.hostname === host &&
        ((record.pid === process.pid &&
          record.processInstanceId !== CURRENT_PROCESS_INSTANCE_ID) ||
          !isPidAlive(record.pid));
      if (expired || deadLocal) {
        await unlink(file).catch(() => undefined);
        continue;
      }
      active.add(record.sessionId);
    } catch {
      // Ignore transient concurrent rename or malformed session file.
    }
  }
  return active;
}
