import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { mkdir, open, rename, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolvePath } from "../paths.js";
import {
  type Category,
  DEFAULT_POLICIES,
  normalizePolicyPatch,
  type Policy,
  type PolicyInput,
  validatePolicy,
} from "./model.js";
import { noLinks } from "./tree.js";

export interface ManagedSettings {
  version: 1;
  storageRoot?: string;
  preflightPrompt?: boolean;
  policies?: Partial<Record<Category, Partial<Policy>>>;
}

type SettingsDocument = Omit<ManagedSettings, "policies"> & {
  policies?: Partial<Record<Category, PolicyInput>>;
};

export function expandHome(value: string, home = homedir()): string {
  if (value === "~") return home;
  if (/^~[\\/]/u.test(value))
    return path.join(home, ...value.slice(2).split(/[\\/]/u));
  if (value.startsWith("~"))
    throw new Error("Use ~ or ~/path, not ~another-user.");
  return value;
}

export function resolveStorageRoot(value: string): string {
  const expanded = expandHome(value);
  if (!path.isAbsolute(expanded))
    throw new Error("Managed storageRoot must be absolute or start with ~/.");
  const resolved = resolvePath(expanded, process.cwd());
  if (path.parse(resolved).root === resolved)
    throw new Error(
      "Managed root must be a dedicated directory, not a filesystem root.",
    );
  return resolved;
}

export function defaultSettingsPath(): string {
  return path.join(getAgentDir(), "file-tools.json");
}

export function defaultSettings(): ManagedSettings {
  const root = path.join(getAgentDir(), "file-tools");
  const relative = path.relative(homedir(), root);
  const portable =
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
  return {
    version: 1,
    preflightPrompt: true,
    storageRoot: portable ? `~/${relative.split(path.sep).join("/")}` : root,
    policies: structuredClone(DEFAULT_POLICIES),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSettings(value: unknown): ManagedSettings {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        !["version", "storageRoot", "preflightPrompt", "policies"].includes(
          key,
        ),
    )
  )
    throw new Error("Unknown settings field or invalid settings object.");
  if (value.version !== undefined && value.version !== 1)
    throw new Error("Unsupported settings version.");
  if (value.storageRoot !== undefined) {
    if (typeof value.storageRoot !== "string")
      throw new Error("storageRoot must be a path string.");
    resolveStorageRoot(value.storageRoot);
  }
  if (
    value.preflightPrompt !== undefined &&
    typeof value.preflightPrompt !== "boolean"
  )
    throw new Error("preflightPrompt must be a boolean.");
  if (value.policies !== undefined) {
    if (
      !object(value.policies) ||
      Object.keys(value.policies).some(
        (key) => !["backup", "temp"].includes(key),
      )
    )
      throw new Error("policies may contain only backup and temp.");
  }
  const policies: ManagedSettings["policies"] = {};
  if (object(value.policies))
    for (const category of ["backup", "temp"] as const) {
      if (value.policies[category] !== undefined) {
        const policy = normalizePolicyPatch(
          value.policies[category],
          `policies.${category}`,
        );
        validatePolicy({ ...DEFAULT_POLICIES[category], ...policy });
        policies[category] = policy;
      }
    }
  return {
    version: 1,
    ...(typeof value.storageRoot === "string"
      ? { storageRoot: value.storageRoot }
      : {}),
    ...(typeof value.preflightPrompt === "boolean"
      ? { preflightPrompt: value.preflightPrompt }
      : {}),
    ...(value.policies !== undefined ? { policies } : {}),
  };
}

/** Preserve source spellings for writes; execution always receives normalized numbers. */
function readSettingsFile(filename: string): {
  document: SettingsDocument;
  settings: ManagedSettings;
} {
  try {
    const info = lstatSync(filename);
    if (!info.isFile() || info.size > 64 * 1024)
      throw new Error("Settings must be a regular file of at most 64 KiB.");
    const raw: unknown = JSON.parse(readFileSync(filename, "utf8"));
    const settings = parseSettings(raw);
    return { document: { ...(raw as SettingsDocument), version: 1 }, settings };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { document: { version: 1 }, settings: { version: 1 } };
    throw new Error(
      `Invalid pi-file-tools settings at ${filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Invalid configuration stops maintenance instead of using destructive defaults. */
export function readSettings(filename: string): ManagedSettings {
  return readSettingsFile(filename).settings;
}

/** The store lock and this config lock keep parallel sessions from losing unrelated policy edits. */
export async function savePolicy(
  filename: string,
  category: Category,
  patch: PolicyInput,
  fallback: Policy,
): Promise<Policy> {
  await noLinks(filename);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const lock = `${filename}.lock`;
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error(
          `Settings locked: ${lock}; inspect other Pi sessions before removing a stale lock.`,
        );
      await delay(25);
    }
  }
  try {
    await noLinks(filename);
    const current = readSettingsFile(filename);
    const normalized = normalizePolicyPatch(patch, `policies.${category}`);
    const policy = {
      ...fallback,
      ...current.settings.policies?.[category],
      ...normalized,
    };
    validatePolicy(policy);
    const next: SettingsDocument = {
      ...current.document,
      policies: {
        ...current.document.policies,
        [category]: {
          ...policy,
          ...current.document.policies?.[category],
          ...patch,
        },
      },
    };
    parseSettings(next);
    const temporary = path.join(
      path.dirname(filename),
      `.${path.basename(filename)}-${randomUUID()}.tmp`,
    );
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filename);
    return policy;
  } finally {
    await rmdir(lock);
  }
}
