import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { exists } from "../src/paths.js";
import { decodeTrashInfo } from "../src/trash/freedesktop.js";
import { serializedBackend, TrashOperations } from "../src/trash/service.js";
import { fixture } from "./support.js";

test("put/list/restore roundtrip preserves Unicode and extension", async (t) => {
  const { root, backend } = await fixture(t);
  const trash = new TrashOperations(backend);
  const name = "中文 文件 [1] # 100%.txt";
  const source = path.join(root, name);
  await writeFile(source, "payload");
  await trash.execute({ action: "put", path: name }, root);
  assert.equal(await exists(source), false);
  const [item] = await backend.list();
  assert.equal(item.name, name);
  assert.equal(item.originalPath, source);
  await trash.execute({ action: "restore", id: item.id }, root);
  assert.equal(await readFile(source, "utf8"), "payload");
  assert.deepEqual(await backend.list(), []);
});
test("nonempty directory put requires recursive and restore is whole-tree", async (t) => {
  const { root, backend } = await fixture(t);
  const trash = new TrashOperations(backend);
  await mkdir(path.join(root, "dir"));
  await writeFile(path.join(root, "dir", "file"), "child");
  await assert.rejects(
    trash.execute({ action: "put", path: "dir" }, root),
    /recursive/,
  );
  await trash.execute({ action: "put", path: "dir", recursive: true }, root);
  const [item] = await backend.list();
  await trash.execute({ action: "restore", id: item.id }, root);
  assert.equal(await readFile(path.join(root, "dir", "file"), "utf8"), "child");
});
test("restore collision keeps both existing and recycled content", async (t) => {
  const { root, backend } = await fixture(t);
  const trash = new TrashOperations(backend);
  const source = path.join(root, "same.txt");
  await writeFile(source, "old");
  const item = await backend.put(source);
  await writeFile(source, "new");
  await assert.rejects(
    trash.execute({ action: "restore", id: item.id }, root),
    /already exists/,
  );
  assert.equal(await readFile(source, "utf8"), "new");
  assert.equal((await backend.list()).length, 1);
  await trash.execute(
    { action: "restore", id: item.id, destination: "recovered.txt" },
    root,
  );
  assert.equal(await readFile(path.join(root, "recovered.txt"), "utf8"), "old");
});
test("empty rejects absent confirmation and ambiguous scope", async (t) => {
  const { root, backend } = await fixture(t);
  const trash = new TrashOperations(backend);
  await assert.rejects(
    trash.execute({ action: "empty", all: true }, root),
    /confirm/,
  );
  await assert.rejects(
    trash.execute({ action: "empty", confirm: "EMPTY" }, root),
    /either/,
  );
  await assert.rejects(
    trash.execute(
      { action: "empty", all: true, ids: ["x"], confirm: "EMPTY" },
      root,
    ),
    /either/,
  );
});
test("selected empty does not touch unselected entries", async (t) => {
  const { root, backend } = await fixture(t);
  const trash = new TrashOperations(backend);
  await writeFile(path.join(root, "a"), "a");
  await writeFile(path.join(root, "b"), "b");
  const a = await backend.put(path.join(root, "a"));
  const b = await backend.put(path.join(root, "b"));
  const result = await trash.execute(
    { action: "empty", ids: [a.id], confirm: "EMPTY" },
    root,
  );
  assert.deepEqual(result.removed, [a.id]);
  assert.deepEqual(
    (await backend.list()).map((item) => item.id),
    [b.id],
  );
  await backend.restore(b.id);
});
test("missing/duplicate empty id fails before mutating any item", async (t) => {
  const { root, backend } = await fixture(t);
  const trash = new TrashOperations(backend);
  await writeFile(path.join(root, "a"), "a");
  const a = await backend.put(path.join(root, "a"));
  await assert.rejects(
    trash.execute(
      { action: "empty", ids: [a.id, "missing"], confirm: "EMPTY" },
      root,
    ),
    /no items emptied/,
  );
  await assert.rejects(
    trash.execute(
      { action: "empty", ids: [a.id, a.id], confirm: "EMPTY" },
      root,
    ),
    /unique/,
  );
  assert.equal((await backend.list()).length, 1);
});
test("all-empty operates on isolated fixture only and handles an empty bin", async (t) => {
  const { root, backend } = await fixture(t);
  const trash = new TrashOperations(backend);
  await writeFile(path.join(root, "a"), "a");
  await backend.put(path.join(root, "a"));
  assert.equal(
    (
      await trash.execute(
        { action: "empty", all: true, confirm: "EMPTY" },
        root,
      )
    ).scope,
    "snapshot-of-entire-bin",
  );
  assert.deepEqual(await backend.list(), []);
  assert.deepEqual(
    (
      await trash.execute(
        { action: "empty", all: true, confirm: "EMPTY" },
        root,
      )
    ).removed,
    [],
  );
});
test("action-specific arguments and pagination are validated", async (t) => {
  const { root, backend } = await fixture(t);
  const trash = new TrashOperations(backend);
  await assert.rejects(
    trash.execute({ action: "list", path: "ignored" }, root),
    /does not apply/,
  );
  await assert.rejects(
    trash.execute({ action: "list", limit: 0 }, root),
    /1..200/,
  );
  await assert.rejects(
    trash.execute({ action: "list", offset: 0.5 }, root),
    /integers/,
  );
  await assert.rejects(
    trash.execute({ action: "restore", id: "missing" }, root),
    /not found/,
  );
  assert.equal(
    (await trash.execute({ action: "list", limit: 1 }, root)).total,
    0,
  );
});
test("malformed trash metadata fails closed", async (t) => {
  const { root, backend } = await fixture(t);
  await writeFile(path.join(root, "a"), "a");
  const a = await backend.put(path.join(root, "a"));
  await writeFile(
    path.join(backend.root, "info", `${a.id}.trashinfo`),
    "[Trash Info]\nPath=%ZZ\nDeletionDate=no\n",
  );
  await assert.rejects(backend.list());
  assert.throws(() => decodeTrashInfo("not metadata"), /header/);
});
test("backend queue recovers after failure and does not overlap calls", async () => {
  let running = 0;
  let peak = 0;
  let sequence = 0;
  const backend = serializedBackend({
    name: "fake",
    put: async () => {
      throw new Error("unused");
    },
    restore: async () => {
      throw new Error("unused");
    },
    purge: async () => ({ removed: [], failed: [] }),
    list: async () => {
      running++;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running--;
      if (sequence++ === 0) throw new Error("first");
      return [];
    },
  });
  const results = await Promise.allSettled([
    backend.list(),
    backend.list(),
    backend.list(),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(results[2].status, "fulfilled");
  assert.equal(peak, 1);
});
