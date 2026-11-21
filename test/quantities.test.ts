import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeRegistry, MANAGED_LIMITS } from "../src/managed/limits.js";
import {
  DEFAULT_POLICIES,
  type Item,
  normalizePolicyPatch,
  planCleanup,
  type StoreState,
  validatePolicy,
} from "../src/managed/model.js";
import { parseQuantity } from "../src/managed/quantities.js";
import { parseSettings, readSettings } from "../src/managed/settings.js";
import { ManagedStore } from "../src/managed/store.js";
import { FreedesktopTrash } from "../src/trash/freedesktop.js";

test("binary count suffixes are case-insensitive and never silently rounded", () => {
  for (const s of ["16k", "16K", "16Ki"])
    assert.equal(parseQuantity(s, "count", "maxItems"), 16384);
  assert.equal(parseQuantity("0.5k", "count", "maxItems"), 512);
  assert.equal(parseQuantity(" 16384 ", "count", "maxItems"), 16384);
  assert.equal(parseQuantity(16384, "count", "maxItems"), 16384);
  assert.throws(
    () => parseQuantity("0.1k", "count", "maxItems"),
    /whole items/,
  );
  assert.throws(() => parseQuantity("1KB", "count", "maxItems"), /unsupported/);
});

test("size aliases k/K m/M g/G t/T and byte names use exact binary multipliers", () => {
  for (const s of ["1k", "1K", "1KB", "1kiB"])
    assert.equal(parseQuantity(s, "bytes", "maxBytes"), 1024);
  for (const s of ["1m", "1M", "1MiB", "1MB"])
    assert.equal(parseQuantity(s, "bytes", "maxBytes"), 1024 ** 2);
  for (const s of ["2g", "2G", "2gb", "2GiB"])
    assert.equal(parseQuantity(s, "bytes", "maxBytes"), 2 * 1024 ** 3);
  assert.equal(parseQuantity("1.5 G", "bytes", "maxBytes"), 1.5 * 1024 ** 3);
  assert.equal(parseQuantity("2T", "bytes", "maxBytes"), 2 * 1024 ** 4);
  assert.equal(parseQuantity("1PiB", "bytes", "maxBytes"), 1024 ** 5);
  assert.equal(parseQuantity("1B", "bytes", "maxBytes"), 1);
});

test("durations have field-specific h/d/w/y/min/s units", () => {
  for (const [s, expected] of [
    ["24h", 24],
    ["30d", 720],
    ["7W", 1176],
    ["100y", 876000],
    ["90min", 1.5],
    ["3600s", 1],
    ["1.5d", 36],
  ] as const)
    assert.equal(parseQuantity(s, "hours", "ttlHours"), expected);
  assert.throws(() => parseQuantity("1m", "hours", "ttlHours"), /durations/);
  assert.throws(
    () => parseQuantity("1.0000000001h", "hours", "ttlHours"),
    /whole milliseconds/,
  );
});

test("invalid quantities and precision overflow fail without rounding", () => {
  for (const value of [
    "",
    " ",
    "-1k",
    "2unknown",
    "1e3",
    "NaN",
    "Infinity",
    "1kk",
    "1.000000000000001",
    "9007199254740993",
    "8192P",
    NaN,
    Infinity,
    1.5,
    true,
    null,
  ])
    assert.throws(() => parseQuantity(value, "bytes", "maxBytes"));
  assert.throws(
    () => parseQuantity("0.1K", "bytes", "maxBytes"),
    /whole bytes/,
  );
  assert.throws(
    () => parseQuantity("1".repeat(129), "count", "maxItems"),
    /short/,
  );
});

test("every policy field normalizes before higher range validation", () => {
  const normalized = normalizePolicyPatch({
    ttlHours: "100y",
    maxItems: "64K",
    maxBytes: "1P",
    purgeAfterHours: "100y",
    maxRecycledBytes: "1PiB",
  });
  assert.deepEqual(normalized, {
    ttlHours: MANAGED_LIMITS.maxHours,
    maxItems: MANAGED_LIMITS.maxItems,
    maxBytes: MANAGED_LIMITS.maxBytes,
    purgeAfterHours: MANAGED_LIMITS.maxHours,
    maxRecycledBytes: MANAGED_LIMITS.maxBytes,
  });
  validatePolicy({ ...DEFAULT_POLICIES.temp, ...normalized });
  for (const patch of [
    { ttlHours: MANAGED_LIMITS.maxHours + 1 },
    { purgeAfterHours: MANAGED_LIMITS.maxHours + 1 },
    { maxItems: MANAGED_LIMITS.maxItems + 1 },
    { maxBytes: MANAGED_LIMITS.maxBytes + 1 },
    { maxRecycledBytes: MANAGED_LIMITS.maxBytes + 1 },
    { ttlHours: 0 },
    { maxItems: 0 },
  ])
    assert.throws(() => validatePolicy({ ...DEFAULT_POLICIES.temp, ...patch }));
  assert.throws(
    () => parseSettings({ policies: { temp: { maxItems: "65k" } } }),
    /maxItems/,
  );
  assert.throws(
    () => parseSettings({ policies: { temp: { maxBytes: "2P" } } }),
    /maxBytes/,
  );
  assert.throws(
    () => parseSettings({ policies: { temp: { ttlHours: "30min" } } }),
    /ttlHours/,
  );
});

test("both settings categories accept mixed numeric and human-readable values", () => {
  const settings = parseSettings({
    policies: {
      backup: {
        ttlHours: "30d",
        maxItems: 256,
        maxBytes: "5g",
        purgeAfterHours: "7d",
        maxRecycledBytes: "1G",
      },
      temp: {
        ttlHours: 144,
        maxItems: "16K",
        maxBytes: "2GiB",
        purgeAfterHours: 168,
        maxRecycledBytes: "1g",
      },
    },
  });
  assert.deepEqual(settings.policies?.backup, {
    ttlHours: 720,
    maxItems: 256,
    maxBytes: 5368709120,
    purgeAfterHours: 168,
    maxRecycledBytes: 1073741824,
  });
  assert.deepEqual(settings.policies?.temp, {
    ttlHours: 144,
    maxItems: 16384,
    maxBytes: 2147483648,
    purgeAfterHours: 168,
    maxRecycledBytes: 1073741824,
  });
});

test("Pi tool policy and per-item TTL accept human values and preserve source spellings", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-file-tools-quantities-"));
  t.after(() => rm(root, { recursive: true, force: false }));
  const configPath = path.join(root, "settings.json");
  const managed = path.join(root, "managed");
  const initial = {
    storageRoot: managed,
    policies: {
      backup: { ttlHours: "30d", maxBytes: "5g" },
      temp: { maxBytes: "2G" },
    },
  };
  await writeFile(configPath, JSON.stringify(initial));
  const now = Date.now();
  const store = new ManagedStore(
    new FreedesktopTrash({ root: path.join(root, "bin") }),
    { root: managed, configPath, now: () => now },
  );
  const created = await store.execute(
    "temp",
    { action: "create", ttlHours: "2d", purpose: "readable per-item TTL" },
    root,
  );
  const item = created.item as { id: string; expiresAt: number };
  assert.equal(item.expiresAt, now + 48 * 3600000);
  await store.execute(
    "temp",
    { action: "touch", id: item.id, ttlHours: "1w" },
    root,
  );
  assert.equal(
    (
      (await store.execute("temp", { action: "inspect", id: item.id }, root))
        .item as Item
    ).expiresAt,
    now + 168 * 3600000,
  );
  const before = await readFile(configPath, "utf8");
  const preview = await store.execute(
    "temp",
    { action: "policy", policy: { maxItems: "16k", maxBytes: "3G" } },
    root,
  );
  assert.equal((preview.proposed as { maxItems: number }).maxItems, 16384);
  assert.equal(await readFile(configPath, "utf8"), before);
  await store.execute(
    "temp",
    {
      action: "policy",
      policy: { maxItems: "16k", maxBytes: "3G" },
      execute: true,
    },
    root,
  );
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(raw.policies.backup, initial.policies.backup);
  assert.equal(raw.policies.temp.maxItems, "16k");
  assert.equal(raw.policies.temp.maxBytes, "3G");
  assert.equal(readSettings(configPath).policies?.temp?.maxItems, 16384);
  assert.equal(
    readSettings(configPath).policies?.temp?.maxBytes,
    3 * 1024 ** 3,
  );
});

test("registry encoding checks UTF-8 byte budget before a commit", () => {
  const value = { purpose: "中文".repeat(50) };
  const encoded = encodeRegistry(value);
  const size = Buffer.byteLength(encoded);
  assert.equal(encodeRegistry(value, size), encoded);
  assert.throws(
    () => encodeRegistry(value, size - 1),
    /previous state was preserved/,
  );
});

test("planning a 16K quota selects the one surplus item", () => {
  const now = Date.now();
  const items: Item[] = Array.from({ length: 16385 }, (_, i) => ({
    id: `temp-${i}`,
    category: "temp",
    name: "file",
    path: "fixture",
    kind: "file",
    project: "fixture",
    purpose: "pure planner fixture",
    owner: "test",
    createdAt: i,
    expiresAt: now + 3600000,
    leaseUntil: 0,
    pinned: false,
    bytes: 1,
    state: "active",
  }));
  const state: StoreState = {
    version: 1,
    policies: {
      ...structuredClone(DEFAULT_POLICIES),
      temp: { ...DEFAULT_POLICIES.temp, maxItems: 16384 },
    },
    items,
    lastSweep: 0,
  };
  const plan = planCleanup(state, "temp", now);
  assert.deepEqual(
    plan.recycle.map((i) => i.id),
    ["temp-0"],
  );
  assert.equal(plan.activeBytes, 16384);
  assert.equal(plan.overBudget, false);
  state.items = items
    .slice(0, 10)
    .map((i) => ({ ...i, bytes: MANAGED_LIMITS.maxBytes }));
  assert.throws(
    () => planCleanup(state, "temp", now),
    /exact integer precision/,
  );
});
