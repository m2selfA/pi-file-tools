import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FileOperations } from "../src/files.js";
import type { Item, Plan } from "../src/managed/model.js";
import { ManagedStore } from "../src/managed/store.js";
import { inspectTree } from "../src/managed/tree.js";
import { exists } from "../src/paths.js";
import { fixture } from "./support.js";

async function setup(t: TestContext) {
  const { root, backend } = await fixture(t);
  let now = Date.now();
  const managed = path.join(root, "managed");
  const store = new ManagedStore(backend, { root: managed, now: () => now });
  const create = async (
    name: string,
    kind: "file" | "directory" = "directory",
    ttlHours = 24,
  ) =>
    (
      await store.execute(
        "temp",
        {
          action: "create",
          name,
          kind,
          ...(kind === "file" ? { content: "owned" } : {}),
          purpose: "isolated managed link fixture",
          ttlHours,
        },
        root,
      )
    ).item as Item;
  const target = path.join(root, "outside");
  await mkdir(target);
  const sentinel = path.join(target, "keep.bin");
  const bytes = Buffer.alloc(16384, 37);
  await writeFile(sentinel, bytes);
  return {
    root,
    backend,
    managed,
    store,
    create,
    target,
    sentinel,
    bytes,
    advance: (hours: number) => {
      now += hours * 3600000;
    },
    now: () => now,
  };
}
const link = async (target: string, destination: string) =>
  symlink(
    target,
    destination,
    process.platform === "win32" ? "junction" : "dir",
  );

test("temp inventory treats external, broken and cyclic links as opaque leaves", async (t) => {
  const s = await setup(t);
  const item = await s.create("linked");
  await writeFile(path.join(item.path, "own.txt"), "x");
  const paths = [
    path.join(item.path, "outside"),
    path.join(item.path, "broken"),
    path.join(item.path, "cycle"),
  ];
  await link(s.target, paths[0]);
  await link(path.join(s.root, "missing-target"), paths[1]);
  await link(item.path, paths[2]);
  const tree = await inspectTree(item.path, 1024 * 1024, undefined, "opaque");
  assert.equal(tree.linkCount, 3);
  assert.equal(tree.entries.length, 5);
  const sizes = await Promise.all(paths.map((p) => lstat(p)));
  assert.equal(tree.bytes, 1 + sizes.reduce((n, i) => n + i.size, 0));
  assert.ok(tree.bytes < s.bytes.length);
  assert.equal((await s.store.maintain()).status, "ok");
  const inspected = (
    await s.store.execute("temp", { action: "inspect", id: item.id }, s.root)
  ).item as Item;
  assert.equal(inspected.linkCount, 3);
  assert.equal(inspected.inspectionError, undefined);
  await s.create("another", "file");
  assert.deepEqual(await readFile(s.sentinel), s.bytes);
});

test("active temp restore preserves a nested junction instead of copying its target", async (t) => {
  const s = await setup(t);
  const item = await s.create("linked");
  const sourceLink = path.join(item.path, "dependency");
  await link(s.target, sourceLink);
  await writeFile(path.join(item.path, "own.txt"), "owned");
  const dest = path.join(s.root, "restored");
  await s.store.execute(
    "temp",
    { action: "restore", id: item.id, destination: dest },
    s.root,
  );
  assert.equal(
    (await lstat(path.join(dest, "dependency"))).isSymbolicLink(),
    true,
  );
  assert.equal(
    await readlink(path.join(dest, "dependency")),
    await readlink(sourceLink),
  );
  assert.equal(await readFile(path.join(dest, "own.txt"), "utf8"), "owned");
  assert.deepEqual(await readFile(s.sentinel), s.bytes);
  assert.equal(
    (await inspectTree(dest, 1024 * 1024, undefined, "opaque")).digest,
    (await inspectTree(item.path, 1024 * 1024, undefined, "opaque")).digest,
  );
});

test("backup link refusal does not register a failed operation or block temp work", async (t) => {
  const s = await setup(t);
  const source = path.join(s.root, "backup-source");
  await mkdir(source);
  await link(s.target, path.join(source, "dependency"));
  await assert.rejects(
    s.store.execute(
      "backup",
      { action: "create", path: source, purpose: "strict link refusal" },
      s.root,
    ),
    /Links\/junctions/,
  );
  assert.equal(
    (await s.store.execute("backup", { action: "list" }, s.root)).total,
    0,
  );
  await s.create("healthy", "file");
  assert.deepEqual(await readFile(s.sentinel), s.bytes);
});

test("one missing item reports unknown usage while healthy recovery and another category work", async (t) => {
  const s = await setup(t);
  const bad = await s.create("missing", "file", 1);
  const good = await s.create("healthy", "file", 1);
  await unlink(bad.path);
  s.advance(2);
  const backup = await s.store.execute(
    "backup",
    {
      action: "create",
      path: s.sentinel,
      purpose: "other category remains available",
    },
    s.root,
  );
  assert.equal((backup.item as Item).state, "active");
  const result = await s.store.maintain();
  assert.equal(result.status, "partial");
  assert.ok((result.failed as { id: string }[]).some((i) => i.id === bad.id));
  const broken = (
    await s.store.execute("temp", { action: "inspect", id: bad.id }, s.root)
  ).item as Item;
  assert.equal(broken.state, "active");
  assert.equal(broken.bytes, bad.bytes);
  assert.ok(broken.inspectionError);
  const plan = (result.temp as { plan: Plan }).plan;
  assert.equal(plan.usage.complete, false);
  assert.deepEqual(plan.usage.unknownItemIds, [bad.id]);
  assert.equal(plan.overBudget, true);
  const recycled = (
    await s.store.execute("temp", { action: "inspect", id: good.id }, s.root)
  ).item as Item;
  assert.equal(recycled.state, "recycled");
  await assert.rejects(s.create("not-admitted", "file"), /unverified usage/);
  await s.store.execute(
    "temp",
    {
      action: "restore",
      id: good.id,
      destination: path.join(s.root, "healthy-restored"),
    },
    s.root,
  );
  await s.store.execute(
    "temp",
    { action: "touch", id: good.id, ttlHours: 1 },
    s.root,
  );
  assert.equal(
    (
      await s.store.execute(
        "temp",
        { action: "release", id: good.id, execute: true },
        s.root,
      )
    ).applied,
    true,
  );
});

test("tampered backup is isolated without changing its mutation state", async (t) => {
  const s = await setup(t);
  const a = (
    await s.store.execute(
      "backup",
      {
        action: "create",
        path: s.sentinel,
        purpose: "tamper fixture",
        ttlHours: 1,
      },
      s.root,
    )
  ).item as Item;
  const source = path.join(s.root, "source-two");
  await writeFile(source, "second");
  const b = (
    await s.store.execute(
      "backup",
      {
        action: "create",
        path: source,
        purpose: "healthy fixture",
        ttlHours: 1,
      },
      s.root,
    )
  ).item as Item;
  await writeFile(a.path, "tampered");
  s.advance(2);
  const result = await s.store.maintain();
  assert.equal(result.status, "partial");
  assert.equal(
    (
      (await s.store.execute("backup", { action: "inspect", id: a.id }, s.root))
        .item as Item
    ).state,
    "active",
  );
  assert.equal(
    (
      (await s.store.execute("backup", { action: "inspect", id: b.id }, s.root))
        .item as Item
    ).state,
    "recycled",
  );
  await s.create("temp-unaffected", "file");
  await s.store.execute(
    "backup",
    {
      action: "restore",
      id: b.id,
      destination: path.join(s.root, "backup-restored"),
    },
    s.root,
  );
  assert.equal(
    await readFile(path.join(s.root, "backup-restored"), "utf8"),
    "second",
  );
});

test("root redirection remains blocked and does not delete the outside target", async (t) => {
  const s = await setup(t);
  const item = await s.create("redirected");
  await rename(item.path, path.join(s.root, "saved-payload"));
  await link(s.target, item.path);
  const result = await s.store.maintain();
  assert.equal(result.status, "partial");
  const blocked = await s.store.execute(
    "temp",
    { action: "release", id: item.id, execute: true },
    s.root,
  );
  assert.equal(blocked.applied, false);
  assert.deepEqual(await readFile(s.sentinel), s.bytes);
  await rename(s.managed, path.join(s.root, "saved-store"));
  await link(s.target, s.managed);
  await assert.rejects(s.store.maintain(), /redirected storage path/);
  assert.deepEqual(await readFile(s.sentinel), s.bytes);
});

test("failed staged restore removes only its own links, preserving outside data", async (t) => {
  const s = await setup(t);
  const item = await s.create("linked");
  await link(s.target, path.join(item.path, "dependency"));
  const files = new FileOperations(s.backend, async () => {
    throw new Error("injected commit failure");
  });
  const reader = new ManagedStore(s.backend, { root: s.managed, files });
  await assert.rejects(
    reader.execute(
      "temp",
      {
        action: "restore",
        id: item.id,
        destination: path.join(s.root, "not-committed"),
      },
      s.root,
    ),
    /injected commit failure/,
  );
  assert.equal(await exists(path.join(s.root, "not-committed")), false);
  assert.ok(
    !(await readdir(s.root)).some((n) => n.startsWith(".pi-file-tools-stage-")),
  );
  assert.deepEqual(await readFile(s.sentinel), s.bytes);
});

test("a junction cwd does not change temp allocation or restore semantics", async (t) => {
  const s = await setup(t);
  const real = path.join(s.root, "real-project");
  const alias = path.join(s.root, "project-alias");
  await mkdir(real);
  await link(real, alias);
  const created = (
    await s.store.execute(
      "temp",
      {
        action: "create",
        name: "file",
        content: "alias-data",
        purpose: "alias cwd",
      },
      alias,
    )
  ).item as Item;
  await s.store.execute(
    "temp",
    { action: "restore", id: created.id, destination: "restored.txt" },
    alias,
  );
  assert.equal(created.project, path.resolve(alias));
  assert.equal(
    await readFile(path.join(real, "restored.txt"), "utf8"),
    "alias-data",
  );
  assert.equal((await lstat(alias)).isSymbolicLink(), true);
});
