import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sourceState } from "../scripts/source-state.js";
import { FileOperations } from "../src/files.js";
import { contains, exists, pathKey } from "../src/paths.js";
import { serializedBackend, TrashOperations } from "../src/trash/service.js";
import { WindowsTrash } from "../src/trash/windows.js";
import type { TrashItem } from "../src/types.js";

test("Windows native recycle/restore/selected-empty roundtrip", {
  skip: process.platform !== "win32",
  timeout: 240000,
}, async () => {
  const backend = serializedBackend(new WindowsTrash());
  const service = new TrashOperations(backend);
  const files = new FileOperations(backend);
  const baseline = await backend.list();
  const baselineIds = new Set(baseline.map((item) => item.id));
  const project = path.resolve(import.meta.dirname, "..");
  const inputState = await sourceState(project);
  const runId = `windows-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const receipts = path.join(project, "verification", "runs", runId);
  await mkdir(receipts, { recursive: true });
  const temp = path.join(project, ".verification-tmp");
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(path.join(temp, "native-"));
  const sys = await mkdtemp(path.join(tmpdir(), "pi-file-tools-native-"));
  const checks: { name: string; status: string; error?: string }[] = [];
  let failure: unknown;
  let cleanupFailure: unknown;
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      checks.push({ name, status: "passed" });
    } catch (error) {
      checks.push({ name, status: "failed", error: String(error) });
      throw error;
    }
  };
  async function put(value: string, recursive = false): Promise<TrashItem> {
    return (
      await service.execute({ action: "put", path: value, recursive }, root)
    ).item as TrashItem;
  }
  try {
    await check("repository-drive Unicode file roundtrip", async () => {
      const source = path.join(root, "中文 文件 [1] ' & $().txt");
      await writeFile(source, "native-文件");
      const item = await put(source);
      assert.equal(await exists(source), false);
      assert.equal(item.name, path.basename(source));
      assert.equal(pathKey(item.originalPath), pathKey(source));
      assert.ok((await backend.list()).some((row) => row.id === item.id));
      await service.execute({ action: "restore", id: item.id }, root);
      assert.equal(await readFile(source, "utf8"), "native-文件");
      assert.ok(!(await backend.list()).some((row) => row.id === item.id));
    });
    await check("system-drive file roundtrip", async () => {
      const source = path.join(sys, "system.txt");
      await writeFile(source, "system");
      const item = await put(source);
      await service.execute({ action: "restore", id: item.id }, root);
      assert.equal(await readFile(source, "utf8"), "system");
    });
    await check("nonempty directory guard and full-tree restore", async () => {
      const source = path.join(root, "中文 目录");
      await mkdir(source);
      await writeFile(path.join(source, "child.txt"), "child");
      await assert.rejects(
        service.execute({ action: "put", path: source }, root),
        /recursive/,
      );
      const item = await put(source, true);
      assert.equal(item.kind, "directory");
      await service.execute({ action: "restore", id: item.id }, root);
      assert.equal(
        await readFile(path.join(source, "child.txt"), "utf8"),
        "child",
      );
    });
    await check("restore collision preserves both versions", async () => {
      const source = path.join(root, "collision.txt");
      await writeFile(source, "old");
      const item = await put(source);
      await writeFile(source, "new");
      await assert.rejects(
        service.execute({ action: "restore", id: item.id }, root),
        /already exists/,
      );
      assert.equal(await readFile(source, "utf8"), "new");
      await service.execute(
        {
          action: "restore",
          id: item.id,
          destination: path.join(root, "recovered.txt"),
        },
        root,
      );
      assert.equal(
        await readFile(path.join(root, "recovered.txt"), "utf8"),
        "old",
      );
    });
    await check(
      "copy and rename overwrite retain recoverable originals",
      async () => {
        const source = path.join(root, "src.txt");
        const destination = path.join(root, "dst.txt");
        await writeFile(source, "new");
        await writeFile(destination, "old-copy");
        const copied = await files.transfer(
          "copy",
          { source, destination, overwrite: true },
          root,
        );
        await backend.restore(
          (copied.replacedItem as TrashItem).id,
          path.join(root, "old-copy.txt"),
        );
        assert.equal(await readFile(destination, "utf8"), "new");
        assert.equal(
          await readFile(path.join(root, "old-copy.txt"), "utf8"),
          "old-copy",
        );
        const renamed = await files.transfer(
          "rename",
          { source: destination, destination: source, overwrite: true },
          root,
        );
        await backend.restore(
          (renamed.replacedItem as TrashItem).id,
          path.join(root, "old-rename.txt"),
        );
        assert.equal(
          await readFile(path.join(root, "old-rename.txt"), "utf8"),
          "new",
        );
        assert.equal(await exists(destination), false);
      },
    );
    await check(
      "native no-clobber move preserves existing target",
      async () => {
        const source = path.join(root, "move-src");
        const destination = path.join(root, "move-dst");
        await writeFile(source, "source");
        await writeFile(destination, "destination");
        const { moveNoReplace } = await import("../src/move.js");
        await assert.rejects(moveNoReplace(source, destination));
        assert.equal(await readFile(source, "utf8"), "source");
        assert.equal(await readFile(destination, "utf8"), "destination");
      },
    );
    await check(
      "cross-volume rename rejects before recycling existing target",
      async () => {
        assert.notEqual(
          (await stat(sys)).dev,
          (await stat(root)).dev,
          "this probe requires distinct C: and E: devices",
        );
        const source = path.join(sys, "cross-volume.txt");
        const destination = path.join(root, "cross-target.txt");
        await writeFile(source, "source");
        await writeFile(destination, "destination");
        const before = (await backend.list()).length;
        await assert.rejects(
          files.transfer(
            "rename",
            { source, destination, overwrite: true },
            root,
          ),
          /Cross-volume/,
        );
        assert.equal(await readFile(source, "utf8"), "source");
        assert.equal(await readFile(destination, "utf8"), "destination");
        assert.equal((await backend.list()).length, before);
      },
    );
    await check("junction recycle/restore preserves its target", async () => {
      const target = path.join(root, "junction-target");
      const link = path.join(root, "junction-link");
      await mkdir(target);
      await writeFile(path.join(target, "keep.txt"), "keep");
      await symlink(target, link, "junction");
      const item = await put(link);
      assert.equal(item.kind, "symlink");
      assert.equal(
        await readFile(path.join(target, "keep.txt"), "utf8"),
        "keep",
      );
      await service.execute({ action: "restore", id: item.id }, root);
      assert.equal((await lstat(link)).isSymbolicLink(), true);
      assert.equal(await readFile(path.join(link, "keep.txt"), "utf8"), "keep");
    });
    await check("selected empty preserves unselected probe", async () => {
      const a = path.join(root, "a.txt");
      const b = path.join(root, "b.txt");
      await writeFile(a, "a");
      await writeFile(b, "b");
      const aa = await put(a);
      const bb = await put(b);
      const result = await service.execute(
        { action: "empty", ids: [aa.id], confirm: "EMPTY" },
        root,
      );
      assert.deepEqual(result.removed, [aa.id]);
      assert.deepEqual(result.failed, []);
      const after = await backend.list();
      assert.ok(!after.some((row) => row.id === aa.id));
      assert.ok(after.some((row) => row.id === bb.id));
      await assert.rejects(
        service.execute({ action: "restore", id: aa.id }, root),
        /not found/,
      );
      await backend.restore(bb.id);
    });
    await check(
      "missing source/id and unconfirmed empty are rejected",
      async () => {
        await assert.rejects(
          service.execute(
            { action: "put", path: path.join(root, "missing") },
            root,
          ),
        );
        await assert.rejects(
          service.execute(
            { action: "empty", ids: ["not-an-id"], confirm: "EMPTY" },
            root,
          ),
          /no items emptied/,
        );
        await assert.rejects(
          service.execute({ action: "empty", all: true }, root),
          /confirm/,
        );
      },
    );
  } catch (error) {
    failure = error;
  }
  let finalCount: number | undefined;
  try {
    const pending = (await backend.list()).filter(
      (item) =>
        !baselineIds.has(item.id) &&
        (contains(root, item.originalPath) || contains(sys, item.originalPath)),
    );
    if (pending.length) {
      const cleaned = await backend.purge(pending.map((item) => item.id));
      assert.deepEqual(cleaned.failed, []);
    }
    const final = await backend.list();
    finalCount = final.length;
    const finalIds = new Set(final.map((item) => item.id));
    for (const id of baselineIds)
      assert.ok(finalIds.has(id), "unrelated baseline entry preserved");
    assert.equal(final.length, baseline.length, "bin baseline restored");
    await rm(root, { recursive: true, force: false });
    await rm(sys, { recursive: true, force: false });
  } catch (error) {
    cleanupFailure = error;
  }
  const finalState = await sourceState(project);
  if (finalState.inputDigest !== inputState.inputDigest)
    failure ??= new Error(
      "Source inputs changed during native verification; evidence rejected.",
    );
  await writeFile(
    path.join(receipts, "source-state.json"),
    JSON.stringify(inputState, null, 2),
  );
  const receipt = {
    inputDigest: inputState.inputDigest,
    sourceUnchanged: finalState.inputDigest === inputState.inputDigest,
    runId,
    platform: process.platform,
    node: process.version,
    baselineCount: baseline.length,
    finalCount,
    baselineIdDigest: createHash("sha256")
      .update(JSON.stringify([...baselineIds].sort()))
      .digest("hex"),
    checks,
    status: failure || cleanupFailure ? "failed" : "passed",
    failure: failure ? String(failure) : null,
    cleanupFailure: cleanupFailure ? String(cleanupFailure) : null,
    wholeSystemBinEmptied: false,
    baselineRestored: !cleanupFailure,
  };
  await writeFile(
    path.join(receipts, "receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt));
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
});
