import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { sourceState } from "../scripts/source-state.js";
import type { Item, StoreState } from "../src/managed/model.js";
import { ManagedStore } from "../src/managed/store.js";
import { inspectTree } from "../src/managed/tree.js";
import { FreedesktopTrash } from "../src/trash/freedesktop.js";

const project = path.resolve(import.meta.dirname, "..");
const before = await sourceState(project);
const checks: Record<string, unknown>[] = [];

test("16K historical receipts larger than 8 MiB survive a registry read/write roundtrip", async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), "pi-file-tools-scale-registry-"),
  );
  t.after(() => rm(root, { recursive: true, force: false }));
  const managed = path.join(root, "managed");
  const store = new ManagedStore(
    new FreedesktopTrash({ root: path.join(root, "bin") }),
    { root: managed },
  );
  await store.execute("temp", { action: "list" }, root);
  const filename = path.join(managed, "state.json");
  const state: StoreState = JSON.parse(await readFile(filename, "utf8"));
  const now = Date.now();
  state.items = Array.from({ length: 16384 }, (_, i): Item => {
    const id = `temp-00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
    return {
      id,
      category: "temp",
      name: "scratch.tmp",
      path: path.join(managed, "temp", id, "scratch.tmp"),
      kind: "file",
      project: root,
      purpose: "x".repeat(400),
      owner: "scale-history-fixture",
      createdAt: now - i,
      expiresAt: now + 3600000,
      leaseUntil: 0,
      pinned: false,
      bytes: 0,
      state: "purged",
    };
  });
  await writeFile(filename, JSON.stringify(state, null, 2));
  const bytesBefore = (await stat(filename)).size;
  assert.ok(
    bytesBefore > 8 * 1024 ** 2,
    "fixture crosses the old registry byte limit",
  );
  assert.equal(
    (await store.execute("temp", { action: "list", limit: 200 }, root)).total,
    16384,
  );
  await store.execute(
    "temp",
    { action: "policy", policy: { maxItems: "32k" }, execute: true },
    root,
  );
  const restored: StoreState = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(restored.items.length, 16384);
  assert.equal(restored.policies.temp.maxItems, 32768);
  assert.equal(restored.items[16383].id, state.items[16383].id);
  checks.push({
    name: "16K historical registry roundtrip",
    records: restored.items.length,
    bytesBefore,
    bytesAfter: (await stat(filename)).size,
    scope: "metadata read/write, not 16K active-item recycling",
  });
});

test("a real directory with 16K files scans beyond the previous 10000-entry bound", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-file-tools-scale-tree-"));
  t.after(() => rm(root, { recursive: true, force: false }));
  const nested = path.join(root, "nested");
  await mkdir(nested);
  for (let start = 0; start < 16384; start += 128)
    await Promise.all(
      Array.from({ length: Math.min(128, 16384 - start) }, (_, offset) =>
        writeFile(path.join(nested, `${start + offset}.txt`), "x"),
      ),
    );
  const tree = await inspectTree(root);
  assert.equal(tree.entries.length, 16386);
  assert.equal(tree.bytes, 16384);
  checks.push({
    name: "16K actual-file tree scan",
    files: 16384,
    entries: tree.entries.length,
    bytes: tree.bytes,
    scope: "recursive integrity scan, not native OS-bin scale behavior",
  });
});

after(async () => {
  const unchanged =
    (await sourceState(project)).inputDigest === before.inputDigest;
  const status = unchanged && checks.length === 2 ? "passed" : "failed";
  const folder = path.join(
    project,
    "verification",
    "runs",
    `managed-scale-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(folder, { recursive: true });
  const receipt = {
    status,
    inputDigest: before.inputDigest,
    sourceUnchanged: unchanged,
    checks,
  };
  await writeFile(
    path.join(folder, "receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  console.log(
    JSON.stringify({
      receipt: path.relative(project, path.join(folder, "receipt.json")),
      ...receipt,
    }),
  );
  assert.equal(unchanged, true, "source changed during scale checks");
  assert.equal(
    checks.length,
    2,
    "empty or incomplete scale evidence is not a pass",
  );
});
