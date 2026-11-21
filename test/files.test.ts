import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { FileOperations } from "../src/files.js";
import { exists } from "../src/paths.js";
import { fixture } from "./support.js";

test("mkdir creates recursively and reports existing directory", async (t) => {
  const { root, backend, move } = await fixture(t);
  const files = new FileOperations(backend, move);
  assert.equal((await files.mkdir("a/b", root)).created, true);
  assert.equal((await files.mkdir("a/b", root)).created, false);
});
test("mkdir refuses existing file and missing parent in nonrecursive mode", async (t) => {
  const { root, backend, move } = await fixture(t);
  const files = new FileOperations(backend, move);
  await writeFile(path.join(root, "file"), "x");
  await assert.rejects(files.mkdir("file", root), /not a directory/);
  await assert.rejects(files.mkdir("x/y", root, false));
});
test("copy stages files and refuses unintended overwrite", async (t) => {
  const { root, backend, move } = await fixture(t);
  const files = new FileOperations(backend, move);
  await writeFile(path.join(root, "src"), "new");
  await writeFile(path.join(root, "dst"), "old");
  await assert.rejects(
    files.transfer("copy", { source: "src", destination: "dst" }, root),
    /overwrite/,
  );
  assert.equal(await readFile(path.join(root, "dst"), "utf8"), "old");
  await files.transfer("copy", { source: "src", destination: "copied" }, root);
  assert.equal(await readFile(path.join(root, "copied"), "utf8"), "new");
});
test("overwrite preserves the old target in the real backend interface", async (t) => {
  const { root, backend, move } = await fixture(t);
  const files = new FileOperations(backend, move);
  await writeFile(path.join(root, "src"), "new");
  await writeFile(path.join(root, "dst"), "old");
  const result = await files.transfer(
    "copy",
    { source: "src", destination: "dst", overwrite: true },
    root,
  );
  assert.ok(result.replacedItem);
  const [old] = await backend.list();
  await backend.restore(old.id, path.join(root, "recovered"));
  assert.equal(await readFile(path.join(root, "recovered"), "utf8"), "old");
  assert.equal(await readFile(path.join(root, "dst"), "utf8"), "new");
});
test("commit failure rolls the recycled destination back", async (t) => {
  const { root, backend } = await fixture(t);
  const files = new FileOperations(backend, async () => {
    throw new Error("injected move failure");
  });
  await writeFile(path.join(root, "src"), "new");
  await writeFile(path.join(root, "dst"), "old");
  await assert.rejects(
    files.transfer(
      "copy",
      { source: "src", destination: "dst", overwrite: true },
      root,
    ),
    /injected/,
  );
  assert.equal(await readFile(path.join(root, "dst"), "utf8"), "old");
  assert.deepEqual(await backend.list(), []);
  assert.ok(
    !(await readdir(root)).some((name) =>
      name.startsWith(".pi-file-tools-stage-"),
    ),
  );
});
test("rollback failure exposes recovery id and retains old content", async (t) => {
  const { root, backend } = await fixture(t);
  const restore = backend.restore.bind(backend);
  backend.restore = async () => {
    throw new Error("injected restore failure");
  };
  const files = new FileOperations(backend, async () => {
    throw new Error("commit failure");
  });
  await writeFile(path.join(root, "src"), "new");
  await writeFile(path.join(root, "dst"), "old");
  await assert.rejects(
    files.transfer(
      "copy",
      { source: "src", destination: "dst", overwrite: true },
      root,
    ),
    /recoverable as trash id/,
  );
  const [old] = await backend.list();
  await restore(old.id, path.join(root, "recovered"));
  assert.equal(await readFile(path.join(root, "recovered"), "utf8"), "old");
});
test("directory copy requires recursive and rejects own descendant", async (t) => {
  const { root, backend, move } = await fixture(t);
  const files = new FileOperations(backend, move);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a"), "a");
  await assert.rejects(
    files.transfer("copy", { source: "src", destination: "dst" }, root),
    /recursive/,
  );
  await assert.rejects(
    files.transfer(
      "copy",
      { source: "src", destination: "src/inside", recursive: true },
      root,
    ),
    /descendant/,
  );
  await files.transfer(
    "copy",
    { source: "src", destination: "dst", recursive: true },
    root,
  );
  assert.equal(await readFile(path.join(root, "dst", "a"), "utf8"), "a");
});
test("rename moves exact path and refuses cwd", async (t) => {
  const { root, backend, move } = await fixture(t);
  const files = new FileOperations(backend, move);
  await writeFile(path.join(root, "src"), "s");
  await files.transfer("rename", { source: "src", destination: "dst" }, root);
  assert.equal(await exists(path.join(root, "src")), false);
  assert.equal(await readFile(path.join(root, "dst"), "utf8"), "s");
  await assert.rejects(
    files.transfer(
      "rename",
      { source: root, destination: `${root}-moved` },
      root,
    ),
    /working directory/,
  );
});
test("aborted operations do not mutate source or destination", async (t) => {
  const { root, backend, move } = await fixture(t);
  const files = new FileOperations(backend, move);
  const signal = AbortSignal.abort();
  await writeFile(path.join(root, "src"), "s");
  await assert.rejects(files.mkdir("no", root, true, signal), /aborted/);
  await assert.rejects(
    files.transfer(
      "rename",
      { source: "src", destination: "no" },
      root,
      signal,
    ),
    /aborted/,
  );
  assert.equal(await exists(path.join(root, "src")), true);
  assert.equal(await exists(path.join(root, "no")), false);
});
