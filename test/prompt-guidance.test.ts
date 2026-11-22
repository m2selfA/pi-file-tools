import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerFileTools } from "../src/index.js";
import {
  defaultSettings,
  parseSettings,
  readSettings,
} from "../src/managed/settings.js";
import { ManagedStore } from "../src/managed/store.js";
import { exists } from "../src/paths.js";
import {
  applyPreflightPrompt,
  PREFLIGHT_GUIDANCE,
  PREFLIGHT_MARKER,
  PREFLIGHT_SECTION,
  type PreflightPromptEvent,
} from "../src/prompt-guidance.js";
import { fixture } from "./support.js";

type Options = BuildSystemPromptOptions & { sections: Record<string, string> };
// The renderer is bound to the locked development SDK; runtime uses public hook types only.
const sdk = (await import(
  pathToFileURL(
    path.join(
      path.dirname(
        fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
      ),
      "core/system-prompt.js",
    ),
  ).href
)) as {
  normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): Options;
  buildSystemPrompt(input: BuildSystemPromptOptions): string;
};
const options = (patch: Partial<BuildSystemPromptOptions> = {}) =>
  sdk.normalizeBuildSystemPromptOptions({
    cwd: "/fixture",
    selectedTools: ["temp", "backup"],
    ...patch,
  });
const event = (value: Options): PreflightPromptEvent => ({
  get systemPrompt() {
    return sdk.buildSystemPrompt(value);
  },
  systemPromptOptions: value,
});
const count = (text: string) => text.split(PREFLIGHT_MARKER).length - 1;
type Hook = (
  event: PreflightPromptEvent,
) => ReturnType<typeof applyPreflightPrompt>;
async function registered(t: TestContext, config?: Record<string, unknown>) {
  const { root, backend } = await fixture(t);
  const managed = path.join(root, "managed");
  const configPath = path.join(root, "settings.json");
  if (config) await writeFile(configPath, JSON.stringify(config));
  const handlers = new Map<string, unknown>();
  const tools: ToolDefinition[] = [];
  const api = {
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    on: (name: string, handler: unknown) => {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  registerFileTools(api, backend, {
    root: managed,
    ...(config ? { configPath } : {}),
  });
  const hook = handlers.get("before_agent_start") as Hook;
  assert.equal(typeof hook, "function");
  return { root, managed, configPath, hook, tools };
}

test("preflight uses one owned section and preserves project context", () => {
  const value = options({
    sections: { foreign: "FOREIGN" },
    contextFiles: [{ path: "AGENTS.md", content: "KEEP" }],
  });
  const before = structuredClone(value.contextFiles);
  assert.equal(applyPreflightPrompt(event(value), true), undefined);
  assert.equal(value.sections.foreign, "FOREIGN");
  assert.deepEqual(value.contextFiles, before);
  assert.equal(value.forceSystemPrompt, undefined);
  assert.equal(value.sections[PREFLIGHT_SECTION], PREFLIGHT_GUIDANCE);
  assert.equal(count(sdk.buildSystemPrompt(value)), 1);
});

test("preflight declares controller-local scope and SSH download boundary", () => {
  assert.match(PREFLIGHT_GUIDANCE, /controller-local filesystem/);
  assert.match(PREFLIGHT_GUIDANCE, /never an active SSH remote host/);
  assert.match(
    PREFLIGHT_GUIDANCE,
    /download a remote tree before backing it up/,
  );
});

test("preflight renders with hidden tools and a custom prompt prefix", () => {
  for (const patch of [
    {
      selectedTools: ["fabric_exec", "temp", "backup"],
      hiddenTools: ["temp", "backup"],
    },
    { customPrompt: "CUSTOM_PREFIX" },
  ]) {
    const value = options(patch);
    applyPreflightPrompt(event(value), true);
    assert.equal(count(sdk.buildSystemPrompt(value)), 1);
    if (patch.customPrompt)
      assert.ok(sdk.buildSystemPrompt(value).includes(patch.customPrompt));
  }
});

test("repeated structured hook calls are idempotent", () => {
  const value = options();
  applyPreflightPrompt(event(value), true);
  const once = sdk.buildSystemPrompt(value);
  applyPreflightPrompt(event(value), true);
  assert.equal(sdk.buildSystemPrompt(value), once);
  assert.equal(count(once), 1);
  assert.equal(value.forceSystemPrompt, undefined);
});

test("disabled preflight removes only its section and leaves tool guidelines", () => {
  const value = options({
    sections: { foreign: "KEEP" },
    toolGuidelines: { temp: ["NATIVE_GUIDE"] },
  });
  applyPreflightPrompt(event(value), true);
  applyPreflightPrompt(event(value), false);
  assert.equal(value.sections[PREFLIGHT_SECTION], undefined);
  assert.equal(value.sections.foreign, "KEEP");
  assert.equal(count(sdk.buildSystemPrompt(value)), 0);
  assert.ok(sdk.buildSystemPrompt(value).includes("NATIVE_GUIDE"));
});

test("forced prompt fallback preserves foreign bytes and deduplicates", () => {
  const prefix = "FOREIGN_PREFIX \n\n";
  const suffix = "\nFOREIGN_SUFFIX";
  const value = options({
    forceSystemPrompt: prefix,
    sections: { foreign: "KEEP" },
  });
  applyPreflightPrompt(event(value), true);
  value.forceSystemPrompt += suffix;
  applyPreflightPrompt(event(value), true);
  assert.equal(count(sdk.buildSystemPrompt(value)), 1);
  assert.ok(value.forceSystemPrompt?.startsWith(prefix));
  applyPreflightPrompt(event(value), false);
  assert.equal(value.forceSystemPrompt, prefix + suffix);
  assert.equal(value.sections.foreign, "KEEP");
});

test("string-only fallback adds once and disables with the original prefix", () => {
  const prefix = "OPAQUE \n\n";
  const first = applyPreflightPrompt({ systemPrompt: prefix }, true);
  assert.ok(first);
  const second = applyPreflightPrompt(
    { systemPrompt: first.systemPrompt },
    true,
  );
  assert.ok(second);
  assert.equal(count(second.systemPrompt), 1);
  assert.equal(
    applyPreflightPrompt({ systemPrompt: second.systemPrompt }, false)
      ?.systemPrompt,
    prefix,
  );
  assert.equal(
    applyPreflightPrompt({ systemPrompt: prefix }, false),
    undefined,
  );
});

test("foreign marker-like and incomplete text is never removed", () => {
  const foreign =
    "PREFIX\n<pi_file_tools>FOREIGN</pi_file_tools>\n<pi_file_tools>partial";
  const value = options({ forceSystemPrompt: foreign });
  applyPreflightPrompt(event(value), true);
  applyPreflightPrompt(event(value), false);
  assert.equal(value.forceSystemPrompt, foreign);
});

test("registered hook defaults on without store creation or AGENTS edits", async (t) => {
  const setup = await registered(t);
  const agents = path.join(setup.root, "AGENTS.md");
  await writeFile(agents, "ORIGINAL PROJECT RULES");
  const value = options();
  setup.hook(event(value));
  assert.equal(count(sdk.buildSystemPrompt(value)), 1);
  assert.equal(setup.tools.length, 6);
  assert.equal(await exists(setup.managed), false);
  assert.equal(await readFile(agents, "utf8"), "ORIGINAL PROJECT RULES");
});

test("an existing config with no preflight option defaults on", async (t) => {
  const setup = await registered(t, {
    version: 1,
    policies: { temp: { maxItems: "16k" } },
  });
  const value = options();
  setup.hook(event(value));
  assert.equal(count(sdk.buildSystemPrompt(value)), 1);
  assert.equal(await exists(setup.managed), false);
});

test("explicit false preserves tools and settings but disables preflight", async (t) => {
  const setup = await registered(t, {
    version: 1,
    preflightPrompt: false,
    policies: { temp: { ttlHours: "1w" } },
  });
  const before = await readFile(setup.configPath, "utf8");
  const value = options();
  setup.hook(event(value));
  assert.equal(count(sdk.buildSystemPrompt(value)), 0);
  assert.equal(setup.tools.length, 6);
  assert.equal(await readFile(setup.configPath, "utf8"), before);
  assert.equal(await exists(setup.managed), false);
});

test("the registered hook reloads on/off changes for the next run", async (t) => {
  const setup = await registered(t, { preflightPrompt: true });
  const value = options({ sections: { foreign: "KEEP" } });
  setup.hook(event(value));
  assert.equal(count(sdk.buildSystemPrompt(value)), 1);
  await writeFile(setup.configPath, JSON.stringify({ preflightPrompt: false }));
  setup.hook(event(value));
  assert.equal(count(sdk.buildSystemPrompt(value)), 0);
  assert.equal(value.sections.foreign, "KEEP");
  await writeFile(setup.configPath, JSON.stringify({ preflightPrompt: true }));
  setup.hook(event(value));
  assert.equal(count(sdk.buildSystemPrompt(value)), 1);
});

test("invalid updated config reports an error before mutating the prompt", async (t) => {
  const setup = await registered(t, { preflightPrompt: true });
  await writeFile(
    setup.configPath,
    JSON.stringify({ preflightPrompt: "false" }),
  );
  const value = options({ sections: { foreign: "KEEP" } });
  const before = sdk.buildSystemPrompt(value);
  assert.throws(
    () => setup.hook(event(value)),
    /preflightPrompt must be a boolean/,
  );
  assert.equal(sdk.buildSystemPrompt(value), before);
  assert.equal(await exists(setup.managed), false);
});

test("preflightPrompt accepts booleans, defaults on, and rejects coercion", () => {
  assert.equal(defaultSettings().preflightPrompt, true);
  assert.equal(parseSettings({}).preflightPrompt ?? true, true);
  assert.equal(parseSettings({ preflightPrompt: true }).preflightPrompt, true);
  assert.equal(
    parseSettings({ preflightPrompt: false }).preflightPrompt,
    false,
  );
  for (const value of [null, 0, 1, "true", "false", [], {}])
    assert.throws(
      () => parseSettings({ preflightPrompt: value }),
      /preflightPrompt must be a boolean/,
    );
});

test("policy saves preserve the preflight switch and readable settings", async (t) => {
  const { root, backend } = await fixture(t);
  const configPath = path.join(root, "settings.json");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      preflightPrompt: false,
      policies: { temp: { ttlHours: "1w" } },
    }),
  );
  const store = new ManagedStore(backend, {
    root: path.join(root, "managed"),
    configPath,
  });
  await store.execute(
    "backup",
    { action: "policy", policy: { maxItems: "16k" }, execute: true },
    root,
  );
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(raw.preflightPrompt, false);
  assert.equal(raw.policies.temp.ttlHours, "1w");
  assert.equal(readSettings(configPath).preflightPrompt, false);
});
