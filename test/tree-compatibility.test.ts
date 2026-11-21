import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { Item } from "../src/managed/model.js";
import { ManagedStore } from "../src/managed/store.js";
import { inspectTree } from "../src/managed/tree.js";
import { exists } from "../src/paths.js";
import { fixture } from "./support.js";

test("link-free trees keep the pre-link-support backup digest format", async (t) => {
  const { root } = await fixture(t);
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "data.txt"), "abc");
  await mkdir(path.join(source, "empty"));
  const legacy = [
    { name: "", kind: "directory", size: 0 },
    {
      name: "data.txt",
      kind: "file",
      size: 3,
      hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    },
    { name: "empty", kind: "directory", size: 0 },
  ];
  const expected = createHash("sha256")
    .update(JSON.stringify(legacy))
    .digest("hex");
  assert.equal((await inspectTree(source)).digest, expected);
  assert.equal(
    (await inspectTree(source, 1024, undefined, "opaque")).digest,
    expected,
  );
});

test("confirmed OS recovery with bad content stays active but quarantined", async (t) => {
  const { root, backend } = await fixture(t);
  const store = new ManagedStore(backend, { root: path.join(root, "managed") });
  const source = path.join(root, "source");
  await writeFile(source, "original");
  const item = (
    await store.execute(
      "backup",
      { action: "create", path: source, purpose: "recovery integrity fixture" },
      root,
    )
  ).item as Item;
  await store.execute(
    "backup",
    { action: "release", id: item.id, execute: true },
    root,
  );
  const restore = backend.restore.bind(backend);
  backend.restore = async (id, destination) => {
    const result = await restore(id, destination);
    await writeFile(result.destination, "changed after confirmed recovery");
    return result;
  };
  const destination = path.join(root, "not-exported");
  const result = await store.execute(
    "backup",
    { action: "restore", id: item.id, destination },
    root,
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.recoveredToManagedPath, true);
  assert.equal(await exists(destination), false);
  const recovered = (
    await store.execute("backup", { action: "inspect", id: item.id }, root)
  ).item as Item;
  assert.equal(recovered.state, "active");
  assert.ok(recovered.inspectionError?.includes("integrity check failed"));
  assert.equal(recovered.trashId, undefined);
  assert.equal(
    await readFile(item.path, "utf8"),
    "changed after confirmed recovery",
  );
  await store.execute(
    "temp",
    { action: "create", purpose: "healthy category still usable" },
    root,
  );
});

test("an unconfirmed restore remains unresolved and blocks later mutation", async (t) => {
  const { root, backend } = await fixture(t);
  const store = new ManagedStore(backend, { root: path.join(root, "managed") });
  const source = path.join(root, "source");
  await writeFile(source, "original");
  const item = (
    await store.execute(
      "backup",
      { action: "create", path: source, purpose: "uncertain recovery fixture" },
      root,
    )
  ).item as Item;
  await store.execute(
    "backup",
    { action: "release", id: item.id, execute: true },
    root,
  );
  backend.restore = async () => {
    throw new Error("injected uncertain recovery");
  };
  await assert.rejects(
    store.execute(
      "backup",
      {
        action: "restore",
        id: item.id,
        destination: path.join(root, "output"),
      },
      root,
    ),
    /injected uncertain recovery/,
  );
  assert.equal(
    (
      (await store.execute("backup", { action: "inspect", id: item.id }, root))
        .item as Item
    ).state,
    "creating",
  );
  await assert.rejects(
    store.execute(
      "temp",
      { action: "create", purpose: "must remain blocked" },
      root,
    ),
    /Unresolved managed operation/,
  );
});
