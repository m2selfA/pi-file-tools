import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FreedesktopTrash } from "../src/trash/freedesktop.js";
import { TrashOperations } from "../src/trash/service.js";

test("Linux native no-clobber and Freedesktop roundtrip in isolated trash", {
  skip: process.platform !== "linux",
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-file-tools-linux-"));
  const backend = new FreedesktopTrash({ root: path.join(root, "Trash") });
  const trash = new TrashOperations(backend);
  try {
    const source = path.join(root, "中文 file #.txt");
    await writeFile(source, "linux");
    await trash.execute({ action: "put", path: source }, root);
    const [item] = await backend.list();
    await trash.execute({ action: "restore", id: item.id }, root);
    assert.equal(await readFile(source, "utf8"), "linux");
    const directory = path.join(root, "directory");
    await mkdir(directory);
    await writeFile(path.join(directory, "child"), "child");
    await trash.execute(
      { action: "put", path: directory, recursive: true },
      root,
    );
    const [dir] = await backend.list();
    await trash.execute(
      { action: "empty", ids: [dir.id], confirm: "EMPTY" },
      root,
    );
    assert.deepEqual(await backend.list(), []);
  } finally {
    await rm(root, { recursive: true, force: false });
  }
});
