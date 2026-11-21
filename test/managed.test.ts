import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedStore } from "../src/managed/store.js";
import { FreedesktopTrash } from "../src/trash/freedesktop.js";

async function setup(now?: () => number) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-file-tools-managed-"));
  const trash = new FreedesktopTrash({ root: path.join(root, "os-trash") });
  const store = new ManagedStore(trash, {
    root: path.join(root, "managed"),
    now,
  });
  return { root, trash, store };
}

test("temp creates centrally, leases protect it, and cleanup needs execute", async (t) => {
  const { root, store } = await setup();
  t.after(() => rm(root, { recursive: true, force: false }));
  const created = await store.execute(
    "temp",
    {
      action: "create",
      name: "scratch.txt",
      content: "hello",
      purpose: "test scratch",
    },
    root,
  );
  const item = created.item as { id: string; path: string; state: string };
  assert.equal(await readFile(item.path, "utf8"), "hello");
  assert.match(item.path, /managed[\\/]temp[\\/]temp-/u);
  const dry = await store.execute("temp", { action: "cleanup" }, root);
  assert.equal(dry.applied, false);
  assert.deepEqual((dry.plan as { recycle: unknown[] }).recycle, []);
  const released = await store.execute(
    "temp",
    { action: "release", id: item.id },
    root,
  );
  assert.equal(released.applied, false);
  const applied = await store.execute(
    "temp",
    { action: "release", id: item.id, execute: true },
    root,
  );
  assert.equal(applied.applied, true);
  assert.equal((applied.item as { state: string }).state, "recycled");
  assert.equal(
    (await store.execute("temp", { action: "list" }, root)).total,
    1,
  );
});

test("backup copies a directory with a digest and restores without overwriting", async (t) => {
  const { root, store } = await setup();
  t.after(() => rm(root, { recursive: true, force: false }));
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "中文.txt"), "backup-content");
  const created = await store.execute(
    "backup",
    { action: "create", path: source, purpose: "before migration" },
    root,
  );
  const item = created.item as {
    id: string;
    path: string;
    digest: string;
    state: string;
  };
  assert.equal(item.state, "active");
  assert.equal(item.digest.length, 64);
  assert.ok(await readFile(path.join(item.path, "中文.txt"), "utf8"));
  const destination = path.join(root, "restored");
  const restored = await store.execute(
    "backup",
    { action: "restore", id: item.id, destination },
    root,
  );
  assert.equal(restored.verifiedDigest, item.digest);
  assert.equal(
    await readFile(path.join(destination, "中文.txt"), "utf8"),
    "backup-content",
  );
  await assert.rejects(
    store.execute(
      "backup",
      { action: "restore", id: item.id, destination },
      root,
    ),
    /already exists/,
  );
});

test("policy preview and quantity cleanup recycle only unpinned managed items", async (t) => {
  let now = Date.now();
  const { root, store } = await setup(() => now);
  t.after(() => rm(root, { recursive: true, force: false }));
  await store.execute(
    "temp",
    { action: "policy", policy: { maxItems: 1 }, execute: true },
    root,
  );
  const first = await store.execute(
    "temp",
    { action: "create", name: "one", content: "1", purpose: "quota one" },
    root,
  );
  now += 16 * 60 * 1000;
  const firstId = (first.item as { id: string }).id;
  const second = await store.execute(
    "temp",
    { action: "create", name: "two", content: "2", purpose: "quota two" },
    root,
  );
  assert.deepEqual(second.evicted as string[], [firstId]);
  const firstState = (
    await store.execute("temp", { action: "inspect", id: firstId }, root)
  ).item as { state: string; trashId: string };
  assert.equal(firstState.state, "recycled");
  assert.ok(firstState.trashId);
  const policy = await store.execute("temp", { action: "policy" }, root);
  assert.equal((policy.proposed as { maxItems: number }).maxItems, 1);
});

test("age, byte quota, pins and concurrent creates are enforced", async (t) => {
  let now = Date.now();
  const { root, store } = await setup(() => now);
  t.after(() => rm(root, { recursive: true, force: false }));
  await store.execute(
    "temp",
    {
      action: "policy",
      policy: { ttlHours: 1, maxItems: 10, maxBytes: 1 },
      execute: true,
    },
    root,
  );
  const first = await store.execute(
    "temp",
    { action: "create", name: "first", content: "a", purpose: "byte quota" },
    root,
  );
  now += 16 * 60 * 1000;
  const second = await store.execute(
    "temp",
    { action: "create", name: "second", content: "b", purpose: "byte quota" },
    root,
  );
  assert.deepEqual(second.evicted, [(first.item as { id: string }).id]);

  await store.execute(
    "temp",
    { action: "policy", policy: { maxBytes: 10 }, execute: true },
    root,
  );
  const pinned = await store.execute(
    "temp",
    {
      action: "create",
      name: "pinned",
      content: "x",
      purpose: "pinned retention",
      pinned: true,
    },
    root,
  );
  const unpinned = await store.execute(
    "temp",
    {
      action: "create",
      name: "unpinned",
      content: "y",
      purpose: "age retention",
    },
    root,
  );
  now += 2 * 60 * 60 * 1000;
  const maintenance = await store.maintain("offline-session");
  const tempMaintenance = maintenance.temp as { released: string[] };
  assert.ok(
    tempMaintenance.released.includes((unpinned.item as { id: string }).id),
  );
  const pinnedState = (
    await store.execute(
      "temp",
      { action: "inspect", id: (pinned.item as { id: string }).id },
      root,
    )
  ).item as { state: string };
  assert.equal(pinnedState.state, "active");

  const concurrent = await Promise.all([
    store.execute(
      "temp",
      {
        action: "create",
        name: "parallel-a",
        content: "a",
        purpose: "lock test",
      },
      root,
    ),
    store.execute(
      "temp",
      {
        action: "create",
        name: "parallel-b",
        content: "b",
        purpose: "lock test",
      },
      root,
    ),
  ]);
  assert.equal(concurrent.length, 2);
});

test("backup refuses a filesystem root", async (t) => {
  const { root, store } = await setup();
  t.after(() => rm(root, { recursive: true, force: false }));
  await assert.rejects(
    store.execute(
      "backup",
      { action: "create", path: path.parse(root).root, purpose: "root guard" },
      root,
    ),
    /filesystem root/,
  );
});

test("modified backup is rejected before maintenance", async (t) => {
  const { root, store } = await setup();
  t.after(() => rm(root, { recursive: true, force: false }));
  const source = path.join(root, "changing.txt");
  await writeFile(source, "before");
  const created = await store.execute(
    "backup",
    { action: "create", path: source, purpose: "integrity test" },
    root,
  );
  const id = (created.item as { id: string }).id;
  await writeFile(
    path.join((created.item as { path: string }).path),
    "tampered",
  );
  await assert.rejects(
    store.execute("backup", { action: "cleanup" }, root),
    /integrity check failed/,
  );
  const inspected = await store.execute(
    "backup",
    { action: "inspect", id },
    root,
  );
  assert.equal((inspected.item as { state: string }).state, "active");
});
