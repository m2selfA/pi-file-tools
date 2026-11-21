import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  discoverAndLoadExtensions,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
  defaultSettings,
  defaultSettingsPath,
  expandHome,
  readSettings,
  resolveStorageRoot,
} from "../src/managed/settings.js";
import { sourceState } from "./source-state.js";

const project = path.resolve(import.meta.dirname, "..");
const configPath = path.resolve(
  expandHome(process.env.PI_FILE_TOOLS_CONFIG ?? defaultSettingsPath()),
);
const raw = await readFile(configPath);
const configHash = createHash("sha256").update(raw).digest("hex");
const settings = readSettings(configPath);
const managedRoot = resolveStorageRoot(
  process.env.PI_FILE_TOOLS_HOME ??
    settings.storageRoot ??
    (defaultSettings().storageRoot as string),
);
async function present(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
const rootExisted = await present(managedRoot);
const before = await sourceState(project);
const loaded = await discoverAndLoadExtensions(
  [path.join(project, "src", "index.ts")],
  project,
  getAgentDir(),
);
assert.deepEqual(loaded.errors, []);
assert.deepEqual(loaded.warnings ?? [], []);
const ours = loaded.extensions.find(
  (e) =>
    e.resolvedPath === path.join(project, "src", "index.ts") ||
    e.path === path.join(project, "src", "index.ts"),
);
assert.ok(ours);
assert.deepEqual([...ours.tools.keys()].sort(), [
  "backup",
  "copy",
  "mkdir",
  "rename",
  "temp",
  "trash",
]);
assert.equal(
  createHash("sha256")
    .update(await readFile(configPath))
    .digest("hex"),
  configHash,
  "user settings changed during the probe",
);
assert.equal(
  await present(managedRoot),
  rootExisted,
  "loading must not initialize or remove the user's store",
);
assert.equal((await sourceState(project)).inputDigest, before.inputDigest);
const receipt = {
  status: "passed",
  inputDigest: before.inputDigest,
  configPath,
  configHash,
  normalizedPolicies: settings.policies,
  managedRoot,
  userStoreCreated: false,
  toolOperationsExecuted: 0,
  sessionStartEmitted: false,
  tools: [...ours.tools.keys()].sort(),
  errors: loaded.errors,
  warnings: loaded.warnings ?? [],
  scope:
    "official loader against actual user settings; no user payload or maintenance operations",
};
const folder = path.join(
  project,
  "verification",
  "runs",
  `user-settings-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
);
await mkdir(folder, { recursive: true });
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
