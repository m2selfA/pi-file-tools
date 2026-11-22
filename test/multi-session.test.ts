import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  acquireFileLock,
  CURRENT_PROCESS_INSTANCE_ID,
  withFileLock,
} from "../src/managed/locks.js";
import type { Item, StoreState } from "../src/managed/model.js";
import { sessionsDir } from "../src/managed/sessions.js";
import { ManagedStore } from "../src/managed/store.js";
import { inspectTree } from "../src/managed/tree.js";
import { exists } from "../src/paths.js";
import { FreedesktopTrash } from "../src/trash/freedesktop.js";
import { fixture } from "./support.js";

const projectRoot = path.resolve(import.meta.dirname, "..");

function spawnDeadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    const pid = child.pid;
    child.on("error", reject);
    child.on("exit", () => {
      if (!pid) reject(new Error("Missing child pid"));
      else resolve(pid);
    });
  });
}

function runChild(
  script: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script, ...args],
      {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("temp scans skip SHA-256 hashing while restore still verifies full digest", async (t) => {
  const { root, backend } = await fixture(t);
  const managed = path.join(root, "managed");
  const store = new ManagedStore(backend, { root: managed });
  const created = (
    await store.execute(
      "temp",
      {
        action: "create",
        name: "payload.bin",
        content: "hello-temp-content",
        purpose: "unhashed refresh vs verified restore",
      },
      root,
    )
  ).item as Item;

  const unhashed = await inspectTree(
    created.path,
    1024 * 1024,
    undefined,
    "opaque",
    false,
  );
  assert.equal(unhashed.hashed, false);
  assert.equal(unhashed.digest, "");
  assert.equal(unhashed.bytes, Buffer.byteLength("hello-temp-content"));

  const maint = await store.maintain("test");
  assert.equal(maint.status, "ok");

  const dest = path.join(root, "restored.bin");
  const restored = await store.execute(
    "temp",
    { action: "restore", id: created.id, destination: dest },
    root,
  );
  assert.match(String(restored.verifiedDigest), /^[a-f0-9]{64}$/u);
  assert.equal(await readFile(dest, "utf8"), "hello-temp-content");
});

test("live lock timeout reports owner diagnostics and preserves the lock", async (t) => {
  const { root, backend } = await fixture(t);
  const managed = path.join(root, "managed");
  const store = new ManagedStore(backend, { root: managed, lockWaitMs: 120 });
  await store.execute("temp", { action: "list" }, root);

  const lockPath = path.join(managed, ".lock");
  await withFileLock(
    {
      lockPath,
      operation: "fixture:live-holder",
      waitMs: 1000,
      sessionId: "sess-live",
    },
    async () => {
      await assert.rejects(
        store.execute(
          "temp",
          { action: "create", purpose: "blocked by live lock" },
          root,
        ),
        (error: Error) => {
          assert.match(error.message, /Managed store is locked/);
          assert.match(error.message, new RegExp(`pid=${process.pid}`));
          assert.match(error.message, /\[alive\]/);
          assert.match(error.message, /op=fixture:live-holder/);
          assert.match(error.message, /session=sess-live/);
          return true;
        },
      );
      assert.equal(await exists(lockPath), true);
    },
  );
  assert.equal(await exists(lockPath), false);
});

test("stale lock reclaim handles dead PIDs and PID reuse, but refuses unresolved states", async (t) => {
  const { root, backend } = await fixture(t);
  const managed = path.join(root, "managed");
  const store = new ManagedStore(backend, { root: managed, lockWaitMs: 200 });
  await store.execute("temp", { action: "list" }, root);

  const lockPath = path.join(managed, ".lock");
  const deadPid = await spawnDeadPid();
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify({
      pid: deadPid,
      processInstanceId: "dead-instance",
      hostname: hostname(),
      operation: "crashed:maintain",
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      startedAtMs: Date.now() - 10_000,
    }),
  );

  const created = await store.execute(
    "temp",
    { action: "create", purpose: "reclaim dead pid lock" },
    root,
  );
  assert.equal((created.item as Item).state, "active");
  assert.equal(await exists(lockPath), false);

  // Simulate PID reuse: same PID as current process, different processInstanceId.
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      processInstanceId: `${CURRENT_PROCESS_INSTANCE_ID}-previous`,
      hostname: hostname(),
      operation: "crashed:pid-reused",
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      startedAtMs: Date.now() - 10_000,
    }),
  );
  const second = await store.execute(
    "temp",
    { action: "create", purpose: "reclaim reused pid lock" },
    root,
  );
  assert.equal((second.item as Item).state, "active");

  // When autoReclaimStaleLocks is false, dead lock is reported clearly without removal.
  const conservative = new ManagedStore(backend, {
    root: managed,
    lockWaitMs: 100,
    autoReclaimStaleLocks: false,
  });
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify({
      pid: deadPid,
      processInstanceId: "dead-instance-2",
      hostname: hostname(),
      operation: "crashed:no-auto-reclaim",
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      startedAtMs: Date.now() - 10_000,
    }),
  );
  await assert.rejects(
    conservative.execute(
      "temp",
      { action: "create", purpose: "must not auto reclaim" },
      root,
    ),
    /\[dead\]/,
  );
  assert.equal(await exists(lockPath), true);
  await rm(lockPath, { recursive: true, force: false });

  // When state.json has an unresolved recycling/creating/purging item, stale reclaim is refused.
  const statePath = path.join(managed, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as StoreState;
  state.items[0].state = "recycling";
  await writeFile(statePath, JSON.stringify(state, null, 2));
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify({
      pid: deadPid,
      processInstanceId: "dead-instance-3",
      hostname: hostname(),
      operation: "crashed:mid-recycle",
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      startedAtMs: Date.now() - 10_000,
    }),
  );
  await assert.rejects(
    store.execute(
      "temp",
      { action: "create", purpose: "must refuse reclaim on unresolved state" },
      root,
    ),
    /Unresolved managed operation/,
  );
  await assert.rejects(
    store.execute(
      "temp",
      { action: "policy", policy: { maxItems: 10 }, execute: true },
      root,
    ),
    /auto-reclaim was refused/,
  );
  assert.equal(await exists(lockPath), true);
});

test("list, inspect and policy preview are lock-free while .lock is held", async (t) => {
  const { root, backend } = await fixture(t);
  const managed = path.join(root, "managed");
  const store = new ManagedStore(backend, { root: managed, lockWaitMs: 100 });
  const item = (
    await store.execute(
      "temp",
      { action: "create", content: "readable", purpose: "lock-free read" },
      root,
    )
  ).item as Item;

  await withFileLock(
    {
      lockPath: path.join(managed, ".lock"),
      operation: "fixture:hold-write-lock",
      waitMs: 1000,
    },
    async () => {
      const listed = await store.execute("temp", { action: "list" }, root);
      assert.equal(listed.total, 1);
      const inspected = await store.execute(
        "temp",
        { action: "inspect", id: item.id },
        root,
      );
      assert.equal((inspected.item as Item).id, item.id);
      const policy = await store.execute("temp", { action: "policy" }, root);
      assert.equal(policy.applied, false);
    },
  );
});

test("backup staging cleans up on failure and failed items do not block other sessions", async (t) => {
  const { root, backend } = await fixture(t);
  const managed = path.join(root, "managed");
  const store = new ManagedStore(backend, { root: managed });
  const badSource = path.join(root, "bad-backup-src");
  const target = path.join(root, "outside");
  await mkdir(badSource);
  await mkdir(target);
  await symlink(
    target,
    path.join(badSource, "link"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    store.execute(
      "backup",
      { action: "create", path: badSource, purpose: "staged failure cleanup" },
      root,
    ),
    /Links\/junctions/,
  );
  assert.equal(
    (await store.execute("backup", { action: "list" }, root)).total,
    0,
  );
  const stagingEntries = await (await import("node:fs/promises")).readdir(
    path.join(managed, ".staging"),
  );
  assert.deepEqual(stagingEntries, []);

  // Inject a historical failed item and verify healthy temp operations still proceed.
  const statePath = path.join(managed, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as StoreState;
  const failedId = "backup-00000000-0000-4000-8000-000000000001";
  await mkdir(path.join(managed, "backup", failedId), { recursive: true });
  state.items.push({
    id: failedId,
    category: "backup",
    name: "broken",
    path: path.join(managed, "backup", failedId, "broken"),
    kind: "file",
    project: root,
    purpose: "historical failed snapshot",
    owner: "pi:other",
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    leaseUntil: 0,
    pinned: false,
    bytes: 0,
    state: "failed",
    error: "disk full during earlier run",
  });
  await writeFile(statePath, JSON.stringify(state, null, 2));

  const healthy = await store.execute(
    "temp",
    { action: "create", content: "ok", purpose: "unaffected by failed item" },
    root,
  );
  assert.equal((healthy.item as Item).state, "active");
  const maint = await store.maintain("test");
  assert.equal(maint.status, "ok");
  assert.equal((maint.failedItems as { id: string }[]).length, 1);
});

test("per-item restore lock blocks concurrent release on same item without blocking other items", async (t) => {
  const { root, backend } = await fixture(t);
  const managed = path.join(root, "managed");
  const store = new ManagedStore(backend, { root: managed, lockWaitMs: 200 });
  const a = (
    await store.execute(
      "temp",
      { action: "create", name: "a.txt", content: "a", purpose: "item a" },
      root,
    )
  ).item as Item;
  const b = (
    await store.execute(
      "temp",
      { action: "create", name: "b.txt", content: "b", purpose: "item b" },
      root,
    )
  ).item as Item;

  const itemLock = await acquireFileLock({
    lockPath: path.join(managed, ".item-locks", `${a.id}.lock`),
    operation: "temp:restore",
    waitMs: 500,
  });
  try {
    await assert.rejects(
      store.execute(
        "temp",
        { action: "release", id: a.id, execute: true },
        root,
      ),
      /currently being restored/,
    );
    const restoredB = await store.execute(
      "temp",
      {
        action: "restore",
        id: b.id,
        destination: path.join(root, "b-out.txt"),
      },
      root,
    );
    assert.equal(await readFile(restoredB.destination as string, "utf8"), "b");
  } finally {
    await itemLock.release();
  }
});

test("background maintain skips on recent sweep or active maintenance lock", async (t) => {
  const { root, backend } = await fixture(t);
  const managed = path.join(root, "managed");
  let now = Date.now();
  const store = new ManagedStore(backend, {
    root: managed,
    now: () => now,
    sweepCooldownMs: 5 * 60 * 1000,
  });
  await store.execute(
    "temp",
    { action: "create", content: "x", purpose: "cooldown fixture" },
    root,
  );

  const first = await store.maintain("s1", { background: true });
  assert.equal(first.status, "ok");
  assert.equal(first.skipped, undefined);

  const second = await store.maintain("s2", { background: true });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "recent-sweep");

  now += 6 * 60 * 1000;
  await withFileLock(
    {
      lockPath: path.join(managed, ".maintenance.lock"),
      operation: "managed:maintain:background",
      waitMs: 500,
    },
    async () => {
      const busy = await store.maintain("s2", { background: true });
      assert.equal(busy.skipped, true);
      assert.equal(busy.reason, "maintenance-in-progress");
    },
  );
});

test("session heartbeat protects active session temp items and scope filters list", async (t) => {
  const { root, backend } = await fixture(t);
  const managed = path.join(root, "managed");
  let now = Date.now();
  const storeA = new ManagedStore(backend, {
    root: managed,
    now: () => now,
    session: { sessionId: "sess-a", cwd: path.join(root, "proj-a") },
  });
  const storeB = new ManagedStore(backend, {
    root: managed,
    now: () => now,
    session: { sessionId: "sess-b", cwd: path.join(root, "proj-b") },
  });
  await mkdir(path.join(root, "proj-a"));
  await mkdir(path.join(root, "proj-b"));

  await storeA.execute(
    "temp",
    { action: "policy", policy: { maxItems: 1 }, execute: true },
    path.join(root, "proj-a"),
  );
  const itemA = (
    await storeA.execute(
      "temp",
      { action: "create", name: "a.tmp", content: "a", purpose: "session a" },
      path.join(root, "proj-a"),
      "pi:sess-a",
    )
  ).item as Item;
  assert.equal(itemA.sessionId, "sess-a");
  assert.equal(
    await exists(path.join(sessionsDir(managed), "sess-a.json")),
    true,
  );

  // Advance past 15m lease while Session A refreshes its heartbeat.
  now += 16 * 60 * 1000;
  await storeA.touchSessionHeartbeat();
  await assert.rejects(
    storeB.execute(
      "temp",
      { action: "create", name: "b.tmp", content: "b", purpose: "session b" },
      path.join(root, "proj-b"),
      "pi:sess-b",
    ),
    /Quota cannot admit/,
  );

  // Once Session A shuts down, Session B can evict Session A's unpinned temp item.
  await storeA.endSession();
  assert.equal(
    await exists(path.join(sessionsDir(managed), "sess-a.json")),
    false,
  );
  const createdB = await storeB.execute(
    "temp",
    { action: "create", name: "b.tmp", content: "b", purpose: "session b" },
    path.join(root, "proj-b"),
    "pi:sess-b",
  );
  assert.deepEqual(createdB.evicted, [itemA.id]);

  const listB = await storeB.execute(
    "temp",
    { action: "list", scope: "session" },
    path.join(root, "proj-b"),
  );
  assert.equal(listB.total, 1);
  assert.equal((listB.items as Item[])[0].id, (createdB.item as Item).id);

  const listProjA = await storeA.execute(
    "temp",
    { action: "list", scope: "project" },
    path.join(root, "proj-a"),
  );
  assert.equal(listProjA.total, 1);
  assert.equal((listProjA.items as Item[])[0].id, itemA.id);

  const listAll = await storeB.execute(
    "temp",
    { action: "list", scope: "all" },
    path.join(root, "proj-b"),
  );
  assert.equal(listAll.total, 2);
});

test("six concurrent child processes share one store and settings without lock errors", async (t: TestContext) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-file-tools-multiproc-"));
  t.after(() => rm(root, { recursive: true, force: false }));
  const managed = path.join(root, "managed");
  const bin = path.join(root, "bin");
  const configPath = path.join(root, "file-tools.json");
  const sourceDir = path.join(root, "backup-src");
  await mkdir(sourceDir);
  await writeFile(path.join(sourceDir, "data.txt"), "shared-backup-payload");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      storageRoot: managed,
      lockWaitMs: 15000,
      sweepCooldownMinutes: 5,
    }),
  );

  const workerScript = `
import { ManagedStore } from ${JSON.stringify(new URL("../src/managed/store.ts", import.meta.url).href)};
import { FreedesktopTrash } from ${JSON.stringify(new URL("../src/trash/freedesktop.ts", import.meta.url).href)};
const [idx, managed, bin, configPath, sourceDir, root] = process.argv.slice(1);
const sessionId = "worker-" + idx;
const store = new ManagedStore(new FreedesktopTrash({ root: bin }), {
  root: managed,
  configPath,
  session: { sessionId, cwd: root },
});
await store.maintain("pi:" + sessionId, { background: true, maxActions: 5, session: { sessionId, cwd: root } });
const t = await store.execute("temp", { action: "create", name: "w-" + idx + ".txt", content: "payload-" + idx, purpose: "multiproc " + idx }, root, "pi:" + sessionId);
const b = await store.execute("backup", { action: "create", path: sourceDir, purpose: "multiproc backup " + idx }, root, "pi:" + sessionId);
const listed = await store.execute("temp", { action: "list", scope: "session" }, root);
if (listed.total !== 1) throw new Error("Expected 1 session temp item, got " + listed.total);
await store.endSession();
console.log(JSON.stringify({ idx, tempId: t.item.id, backupId: b.item.id }));
`;

  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      runChild(workerScript, [
        String(i),
        managed,
        bin,
        configPath,
        sourceDir,
        root,
      ]),
    ),
  );
  for (const res of results) {
    assert.equal(
      res.code,
      0,
      `Worker failed (code=${res.code}): ${res.stderr}\n${res.stdout}`,
    );
  }

  const verifier = new ManagedStore(new FreedesktopTrash({ root: bin }), {
    root: managed,
    configPath,
  });
  const temps = await verifier.execute("temp", { action: "list" }, root);
  const backups = await verifier.execute("backup", { action: "list" }, root);
  assert.equal(temps.total, 6);
  assert.equal(backups.total, 6);
  assert.equal(await exists(path.join(managed, ".lock")), false);
  assert.equal(await exists(path.join(managed, ".maintenance.lock")), false);
  assert.equal((await lstat(path.join(managed, "state.json"))).isFile(), true);
});
