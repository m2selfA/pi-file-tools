import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_POLICIES } from "../src/managed/model.js";
import {
  defaultSettings,
  defaultSettingsPath,
  expandHome,
  parseSettings,
  readSettings,
  resolveStorageRoot,
} from "../src/managed/settings.js";
import { ManagedStore } from "../src/managed/store.js";
import { exists } from "../src/paths.js";
import { FreedesktopTrash } from "../src/trash/freedesktop.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "pi-file-tools-settings-"),
  );
  t.after(() => rm(directory, { recursive: true, force: false }));
  const root = path.join(directory, "managed");
  const configPath = path.join(directory, "file-tools.json");
  const trash = new FreedesktopTrash({ root: path.join(directory, "bin") });
  const write = (settings: unknown) =>
    writeFile(configPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { directory, root, configPath, trash, write };
}

function withHomeOverride<T>(value: string, fn: () => T): T {
  const old = process.env.PI_FILE_TOOLS_HOME;
  process.env.PI_FILE_TOOLS_HOME = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.PI_FILE_TOOLS_HOME;
    else process.env.PI_FILE_TOOLS_HOME = old;
  }
}

test("settings expand ~ and both separator styles using the user HOME", () => {
  assert.equal(expandHome("~"), homedir());
  assert.equal(expandHome("~/one/two"), path.join(homedir(), "one", "two"));
  assert.equal(expandHome("~\\one\\two"), path.join(homedir(), "one", "two"));
  assert.equal(
    resolveStorageRoot("~/file-tools-test"),
    path.join(homedir(), "file-tools-test"),
  );
  assert.throws(() => resolveStorageRoot("~someone/data"), /another-user/);
  assert.throws(() => resolveStorageRoot("relative/data"), /absolute/);
  assert.throws(
    () => resolveStorageRoot(path.parse(homedir()).root),
    /filesystem root/,
  );
});

test("default settings and packaged example preserve the established limits", async () => {
  assert.equal(path.basename(defaultSettingsPath()), "file-tools.json");
  assert.deepEqual(defaultSettings().policies, DEFAULT_POLICIES);
  assert.equal(defaultSettings().preflightPrompt, true);
  const example = parseSettings(
    JSON.parse(
      await readFile(
        new URL("../file-tools.example.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const tuned = parseSettings({
    lockWaitMs: 15000,
    sweepCooldownMinutes: 10,
    autoReclaimStaleLocks: false,
  });
  assert.equal(tuned.lockWaitMs, 15000);
  assert.equal(tuned.sweepCooldownMinutes, 10);
  assert.equal(tuned.autoReclaimStaleLocks, false);
  assert.equal(example.storageRoot, "~/.pi/agent/file-tools");
  assert.equal(example.preflightPrompt, true);
  assert.deepEqual(example.policies, DEFAULT_POLICIES);
});

test("partial settings merge defaults; missing files do not initialize storage", async (t) => {
  const { root, configPath, trash, write } = await fixture(t);
  assert.deepEqual(readSettings(configPath), { version: 1 });
  const store = new ManagedStore(trash, { root, configPath });
  assert.equal(await exists(root), false);
  await write({ storageRoot: root, policies: { backup: { ttlHours: 4 } } });
  const result = await store.execute("backup", { action: "policy" }, root);
  assert.deepEqual(result.current, { ...DEFAULT_POLICIES.backup, ttlHours: 4 });
  assert.equal(result.settingsPath, configPath);
});

test("HOME works for explicit roots and PI_FILE_TOOLS_HOME takes precedence", async (t) => {
  const { directory, root, configPath, trash, write } = await fixture(t);
  const tilde = `~/${path.relative(homedir(), root).split(path.sep).join("/")}`;
  await write({ storageRoot: path.join(directory, "from-file") });
  assert.equal(new ManagedStore(trash, { root: tilde, configPath }).root, root);
  const store = withHomeOverride(
    tilde,
    () => new ManagedStore(trash, { configPath }),
  );
  assert.equal(store.root, root);
  assert.equal(
    (await store.execute("temp", { action: "list" }, directory)).root,
    root,
  );
  assert.equal(await exists(path.join(directory, "from-file")), false);
  await write({ storageRoot: tilde });
  assert.equal(new ManagedStore(trash, { configPath }).root, root);
});

test("backup and temp each use configured TTL, counts, bytes and recovery windows", async (t) => {
  const { directory, root, configPath, trash, write } = await fixture(t);
  const backup = {
    ttlHours: 4,
    maxItems: 3,
    maxBytes: 64,
    purgeAfterHours: 2,
    maxRecycledBytes: 1024,
  };
  const temp = {
    ttlHours: 3,
    maxItems: 4,
    maxBytes: 128,
    purgeAfterHours: 5,
    maxRecycledBytes: 2048,
  };
  await write({ storageRoot: root, policies: { backup, temp } });
  const now = Date.now();
  const store = new ManagedStore(trash, { root, configPath, now: () => now });
  const source = path.join(directory, "source.txt");
  await writeFile(source, "snapshot");
  const b = await store.execute(
    "backup",
    { action: "create", path: source, purpose: "configured backup" },
    directory,
  );
  const a = await store.execute(
    "temp",
    { action: "create", purpose: "configured temp" },
    directory,
  );
  assert.equal((b.item as { expiresAt: number }).expiresAt, now + 4 * 3600000);
  assert.equal((a.item as { expiresAt: number }).expiresAt, now + 3 * 3600000);
  assert.deepEqual(
    (await store.execute("backup", { action: "list" }, directory)).policy,
    backup,
  );
  assert.deepEqual(
    (await store.execute("temp", { action: "list" }, directory)).policy,
    temp,
  );
});

test("file policy edits apply to existing storage without rewriting item expiry", async (t) => {
  const { directory, root, configPath, trash, write } = await fixture(t);
  await write({ storageRoot: root, policies: { temp: { ttlHours: 8 } } });
  const store = new ManagedStore(trash, { root, configPath });
  const before = (
    await store.execute(
      "temp",
      { action: "create", purpose: "existing expiry" },
      directory,
    )
  ).item as { id: string; expiresAt: number };
  await write({
    storageRoot: root,
    policies: {
      temp: { ttlHours: 2, maxItems: 7, maxBytes: 500, purgeAfterHours: 3 },
    },
  });
  assert.deepEqual(
    (await store.execute("temp", { action: "list" }, directory)).policy,
    {
      ...DEFAULT_POLICIES.temp,
      ttlHours: 2,
      maxItems: 7,
      maxBytes: 500,
      purgeAfterHours: 3,
    },
  );
  assert.equal(
    (
      (
        await store.execute(
          "temp",
          { action: "inspect", id: before.id },
          directory,
        )
      ).item as { expiresAt: number }
    ).expiresAt,
    before.expiresAt,
  );
});

test("policy preview is read-only; executed edits persist and preserve the other category", async (t) => {
  const { directory, root, configPath, trash, write } = await fixture(t);
  await write({
    storageRoot: root,
    policies: { backup: { ttlHours: 6 }, temp: { maxItems: 9 } },
  });
  const store = new ManagedStore(trash, { root, configPath });
  const before = await readFile(configPath, "utf8");
  await store.execute(
    "backup",
    { action: "policy", policy: { maxItems: 4 } },
    directory,
  );
  assert.equal(await readFile(configPath, "utf8"), before);
  await store.execute(
    "backup",
    { action: "policy", policy: { maxItems: 4 }, execute: true },
    directory,
  );
  const settings = readSettings(configPath);
  assert.equal(settings.storageRoot, root);
  assert.deepEqual(settings.policies?.temp, { maxItems: 9 });
  assert.equal(settings.policies?.backup?.ttlHours, 6);
  assert.equal(settings.policies?.backup?.maxItems, 4);
  const reopened = new ManagedStore(trash, { root, configPath });
  assert.equal(
    (
      (await reopened.execute("backup", { action: "policy" }, directory))
        .current as { maxItems: number }
    ).maxItems,
    4,
  );
});

test("parallel stores editing different policies do not lose configuration updates", async (t) => {
  const { directory, root, configPath, trash, write } = await fixture(t);
  await write({ storageRoot: root });
  const first = new ManagedStore(trash, { root, configPath });
  const second = new ManagedStore(trash, {
    root: path.join(directory, "second-store"),
    configPath,
  });
  await Promise.all([
    first.execute(
      "backup",
      { action: "policy", policy: { maxItems: 7 }, execute: true },
      directory,
    ),
    second.execute(
      "temp",
      { action: "policy", policy: { maxItems: 8 }, execute: true },
      directory,
    ),
  ]);
  assert.equal(readSettings(configPath).policies?.backup?.maxItems, 7);
  assert.equal(readSettings(configPath).policies?.temp?.maxItems, 8);
});

test("malformed settings stop maintenance before mutation instead of using defaults", async (t) => {
  const { directory, root, configPath, trash } = await fixture(t);
  const store = new ManagedStore(trash, { root, configPath });
  await writeFile(configPath, "{broken");
  await assert.rejects(store.maintain(), /Invalid pi-file-tools settings/);
  await assert.rejects(
    store.execute("temp", { action: "list" }, directory),
    /Invalid pi-file-tools settings/,
  );
  assert.equal(await exists(root), false);
  assert.throws(
    () => new ManagedStore(trash, { root, configPath }),
    /Invalid pi-file-tools settings/,
  );
});

test("settings reject unknown fields, invalid versions and unsafe policy values", () => {
  for (const value of [
    null,
    [],
    { unknown: true },
    { version: 2 },
    { storageRoot: 12 },
    { policies: null },
    { policies: { wrong: {} } },
    { policies: { temp: [] } },
    { policies: { temp: { maxItems: 0 } } },
    { policies: { backup: { ttlHours: "24unknown" } } },
    { policies: { temp: { maxBytes: 0 } } },
    { policies: { backup: { purgeAfterHours: -1 } } },
    { policies: { temp: { typo: 1 } } },
    { lockWaitMs: 50 },
    { lockWaitMs: 100.5 },
    { sweepCooldownMinutes: -1 },
    { autoReclaimStaleLocks: "true" },
  ])
    assert.throws(() => parseSettings(value));
});

test("changing the configured storageRoot requires reload and preserves old data", async (t) => {
  const { directory, root, configPath, trash, write } = await fixture(t);
  await write({ storageRoot: root });
  const store = withHomeOverride(
    root,
    () => new ManagedStore(trash, { configPath }),
  );
  await write({ storageRoot: path.join(directory, "new-root") });
  assert.equal(
    (await store.execute("temp", { action: "list" }, directory)).root,
    root,
  );
  const configured = new ManagedStore(trash, { configPath });
  const source = await configured.execute(
    "temp",
    { action: "create", purpose: "root migration guard" },
    directory,
  );
  await write({ storageRoot: path.join(directory, "another-root") });
  await assert.rejects(configured.maintain(), /reload the Pi extension/);
  assert.equal(await exists((source.item as { path: string }).path), true);
  assert.equal(await exists(path.join(directory, "another-root")), false);
});

test("configured bytes and recovery retention drive selected-only recycle/purge", async (t) => {
  const { directory, root, configPath, trash, write } = await fixture(t);
  await write({
    storageRoot: root,
    policies: { temp: { ttlHours: 1, maxBytes: 2, purgeAfterHours: 2 } },
  });
  let now = Date.now();
  const store = new ManagedStore(trash, { root, configPath, now: () => now });
  const a = await store.execute(
    "temp",
    { action: "create", content: "a", purpose: "config quota first" },
    directory,
  );
  now += 16 * 60000;
  await store.execute(
    "temp",
    { action: "create", content: "bb", purpose: "config quota second" },
    directory,
  );
  const first = (
    await store.execute(
      "temp",
      { action: "inspect", id: (a.item as { id: string }).id },
      directory,
    )
  ).item as { state: string; trashId: string };
  assert.equal(first.state, "recycled");
  const unrelated = path.join(directory, "unrelated.txt");
  await writeFile(unrelated, "keep");
  const sentinel = await trash.put(unrelated);
  now += 3600000;
  await store.maintain();
  assert.ok((await trash.list()).some((i) => i.id === first.trashId));
  now += 3600000;
  await store.maintain();
  const ids = (await trash.list()).map((i) => i.id);
  assert.equal(ids.includes(first.trashId), false);
  assert.equal(ids.includes(sentinel.id), true);
});
