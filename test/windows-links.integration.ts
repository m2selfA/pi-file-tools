import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { sourceState } from "../scripts/source-state.js";
import { windowsLinkKinds } from "../src/links.js";
import type { Item } from "../src/managed/model.js";
import { ManagedStore } from "../src/managed/store.js";
import { inspectTree } from "../src/managed/tree.js";
import { serializedBackend } from "../src/trash/service.js";
import { WindowsTrash } from "../src/trash/windows.js";

const project = path.resolve(import.meta.dirname, "..");
const before = await sourceState(project);
const enabled = process.platform === "win32";
const backend = serializedBackend(new WindowsTrash());
const baseline = enabled ? await backend.list() : [];
const roots: string[] = [];
const checks: Record<string, unknown>[] = [];
let failure: string | undefined;
let requiredPassed = false;
let optionalStatus = "pending";
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const sentinelData = Buffer.alloc(32768, 91);
async function fixture() {
  const root = await mkdtemp(
    path.join(tmpdir(), "pi-file-tools-native-links-"),
  );
  roots.push(root);
  const target = path.join(root, `outside-target-${randomUUID()}`);
  await mkdir(target);
  await writeFile(path.join(target, "keep.bin"), sentinelData);
  return { root, target, sentinel: path.join(target, "keep.bin") };
}
async function unchanged(file: string) {
  assert.equal(digest(await readFile(file)), digest(sentinelData));
}

test("Windows nested junction recycle, restore and permanent purge preserve outside data", {
  skip: !enabled,
}, async () => {
  const f = await fixture();
  let now = Date.now();
  const store = new ManagedStore(backend, {
    root: path.join(f.root, "managed"),
    now: () => now,
  });
  try {
    await store.execute(
      "temp",
      {
        action: "policy",
        policy: { ttlHours: 1, purgeAfterHours: 1 },
        execute: true,
      },
      f.root,
    );
    const item = (
      await store.execute(
        "temp",
        {
          action: "create",
          kind: "directory",
          name: "workspace",
          purpose: "native nested junction fixture",
          ttlHours: 1,
        },
        f.root,
      )
    ).item as Item;
    await writeFile(path.join(item.path, "owned.txt"), "nested-owned-data");
    await mkdir(path.join(item.path, "node_modules"));
    await mkdir(path.join(item.path, "nested", "deeper"), { recursive: true });
    const links = [
      path.join(item.path, "node_modules", "@earendil-works"),
      path.join(item.path, "nested", "deeper", "broken"),
      path.join(item.path, "nested", "deeper", "cycle"),
    ];
    await symlinkJunction(f.target, links[0]);
    await symlinkJunction(path.join(f.root, "missing"), links[1]);
    await symlinkJunction(item.path, links[2]);
    const kinds = await windowsLinkKinds(links);
    assert.deepEqual([...kinds.values()], ["junction", "junction", "junction"]);
    const tree = await inspectTree(item.path, 1024 * 1024, undefined, "opaque");
    assert.equal(tree.linkCount, 3);
    assert.ok(tree.bytes < sentinelData.length);
    assert.equal((await store.maintain()).status, "ok");
    await unchanged(f.sentinel);
    const activeCopy = path.join(f.root, "active-copy");
    await store.execute(
      "temp",
      { action: "restore", id: item.id, destination: activeCopy },
      f.root,
    );
    assert.equal(
      (
        await lstat(path.join(activeCopy, "node_modules", "@earendil-works"))
      ).isSymbolicLink(),
      true,
    );
    assert.equal(
      (
        await windowsLinkKinds([
          path.join(activeCopy, "node_modules", "@earendil-works"),
        ])
      ).get(path.join(activeCopy, "node_modules", "@earendil-works")),
      "junction",
    );
    await unchanged(f.sentinel);
    const released = await store.execute(
      "temp",
      { action: "release", id: item.id, execute: true },
      f.root,
    );
    const recycled = released.item as Item;
    assert.equal(recycled.state, "recycled");
    assert.ok(recycled.trashId);
    assert.equal(
      (await inspectTree(recycled.trashId, 1024 * 1024, undefined, "opaque"))
        .digest,
      tree.digest,
    );
    await unchanged(f.sentinel);
    const restored = await store.execute(
      "temp",
      {
        action: "restore",
        id: item.id,
        destination: path.join(f.root, "bin-copy"),
      },
      f.root,
    );
    assert.equal(restored.verifiedDigest, tree.digest);
    await unchanged(f.sentinel);
    await store.execute(
      "temp",
      { action: "release", id: item.id, execute: true },
      f.root,
    );
    now += 2 * 3600000;
    const sweep = await store.maintain();
    assert.equal(sweep.status, "ok");
    assert.deepEqual((sweep.temp as { purged: string[] }).purged, [item.id]);
    await unchanged(f.sentinel);
    checks.push({
      name: "nested junctions",
      status: "passed",
      linkKinds: [...kinds.values()],
      opaqueLinks: 3,
      activeRestore: true,
      recycledRestore: true,
      permanentPurge: true,
      externalSentinelSha256: digest(sentinelData),
      externalSentinelUnchanged: true,
    });
    requiredPassed = true;
  } catch (error) {
    failure = String(error);
    throw error;
  }
});
async function symlinkJunction(target: string, destination: string) {
  const { symlink } = await import("node:fs/promises");
  await symlink(target, destination, "junction");
}

test("Windows file and directory symbolic links retain type and raw targets", {
  skip: !enabled,
}, async (t) => {
  const f = await fixture();
  const store = new ManagedStore(backend, {
    root: path.join(f.root, "managed"),
  });
  try {
    const item = (
      await store.execute(
        "temp",
        {
          action: "create",
          kind: "directory",
          name: "symlinks",
          purpose: "native file/dir symbolic link fixture",
        },
        f.root,
      )
    ).item as Item;
    const file = path.join(item.path, "file-link");
    const dir = path.join(item.path, "dir-link");
    const relativeDir = path.join(item.path, "relative-dir-link");
    const { symlink } = await import("node:fs/promises");
    try {
      await symlink(
        path.relative(item.path, path.join(f.target, "keep.bin")),
        file,
        "file",
      );
      await symlink(f.target, dir, "dir");
      await symlink(path.relative(item.path, f.target), relativeDir, "dir");
    } catch (error) {
      if (
        ["EPERM", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        optionalStatus = "skipped-OS-link-privilege";
        checks.push({
          name: "file/dir symbolic links",
          status: optionalStatus,
        });
        t.skip(
          "Current OS policy does not allow creating symbolic links; no policy changed.",
        );
        return;
      }
      throw error;
    }
    const sourceKinds = await windowsLinkKinds([file, dir, relativeDir]);
    assert.deepEqual([...sourceKinds.values()], ["file", "dir", "dir"]);
    const dest = path.join(f.root, "restored");
    await store.execute(
      "temp",
      { action: "restore", id: item.id, destination: dest },
      f.root,
    );
    const output = [
      path.join(dest, "file-link"),
      path.join(dest, "dir-link"),
      path.join(dest, "relative-dir-link"),
    ];
    assert.deepEqual(
      [...(await windowsLinkKinds(output)).values()],
      ["file", "dir", "dir"],
    );
    assert.equal(await readlink(output[0]), await readlink(file));
    assert.equal(await readlink(output[1]), await readlink(dir));
    assert.equal(await readlink(output[2]), await readlink(relativeDir));
    await store.execute(
      "temp",
      { action: "release", id: item.id, execute: true },
      f.root,
    );
    await unchanged(f.sentinel);
    await store.execute(
      "temp",
      {
        action: "restore",
        id: item.id,
        destination: path.join(f.root, "from-bin"),
      },
      f.root,
    );
    await unchanged(f.sentinel);
    await store.execute(
      "temp",
      { action: "policy", policy: { purgeAfterHours: 1 }, execute: true },
      f.root,
    );
    await store.execute(
      "temp",
      { action: "release", id: item.id, execute: true },
      f.root,
    );
    const later = new ManagedStore(backend, {
      root: path.join(f.root, "managed"),
      now: () => Date.now() + 2 * 3600000,
    });
    assert.equal((await later.maintain()).status, "ok");
    await unchanged(f.sentinel);
    optionalStatus = "passed";
    checks.push({
      name: "file/dir symbolic links",
      status: "passed",
      linkKinds: ["file", "dir"],
      restore: true,
      recycle: true,
      permanentPurge: true,
      externalSentinelUnchanged: true,
    });
  } catch (error) {
    optionalStatus = "failed";
    failure = String(error);
    throw error;
  }
});

after(async () => {
  let cleanupFailure: string | undefined;
  if (enabled) {
    try {
      const owned = (await backend.list()).filter(
        (i) =>
          !baseline.some((b) => b.id === i.id) &&
          roots.some((root) =>
            i.originalPath
              .toLowerCase()
              .startsWith(root.toLowerCase() + path.sep),
          ),
      );
      // After an uncertain/failed test, recover only known fixture paths rather than retry deletion.
      for (let i = 0; i < owned.length; i++)
        await backend.restore(
          owned[i].id,
          path.join(roots[0], `recovered-fixture-${i}`),
        );
    } catch (error) {
      cleanupFailure = String(error);
    }
  }
  const final = enabled ? await backend.list() : [];
  const baselineRestored =
    JSON.stringify(final.map((i) => i.id).sort()) ===
    JSON.stringify(baseline.map((i) => i.id).sort());
  const sourceUnchanged =
    (await sourceState(project)).inputDigest === before.inputDigest;
  const status = !enabled
    ? "skipped"
    : requiredPassed &&
        ["passed", "skipped-OS-link-privilege"].includes(optionalStatus) &&
        baselineRestored &&
        sourceUnchanged &&
        !cleanupFailure
      ? "passed"
      : "failed";
  const folder = path.join(
    project,
    "verification/runs",
    `windows-links-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(folder, { recursive: true });
  const receipt = {
    status,
    inputDigest: before.inputDigest,
    sourceUnchanged,
    requiredJunctionGatePassed: requiredPassed,
    optionalSymbolicLinks: optionalStatus,
    checks,
    baselineCount: baseline.length,
    finalCount: final.length,
    baselineRestored,
    failure: failure ?? null,
    cleanupFailure: cleanupFailure ?? null,
    wholeSystemBinEmptied: false,
    scope:
      "Fresh isolated fixtures only; never the reported user directory or real SDK target",
    preservedFailedFixtureRoots: status === "failed" ? roots : [],
  };
  await writeFile(
    path.join(folder, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      receipt: path.relative(project, path.join(folder, "receipt.json")),
      ...receipt,
    }),
  );
  if (status === "passed")
    for (const root of roots) await rm(root, { recursive: true, force: false });
  if (enabled) {
    assert.equal(status, "passed");
  }
});
