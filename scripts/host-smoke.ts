import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discoverAndLoadExtensions,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
  PREFLIGHT_MARKER,
  PREFLIGHT_SECTION,
  type PreflightPromptEvent,
} from "../src/prompt-guidance.js";
import { sourceState } from "./source-state.js";

const root = path.resolve(import.meta.dirname, "..");
const agentDir = await mkdtemp(path.join(tmpdir(), "pi-file-tools-host-"));
const previousManagedHome = process.env.PI_FILE_TOOLS_HOME;
const previousManagedConfig = process.env.PI_FILE_TOOLS_CONFIG;
process.env.PI_FILE_TOOLS_CONFIG = path.join(agentDir, "file-tools.json");
delete process.env.PI_FILE_TOOLS_HOME;
const configuredRoot = path.join(agentDir, "configured-managed");
const agentRulesFile = path.join(agentDir, "AGENTS.md");
await writeFile(agentRulesFile, "HOST PROJECT RULES\n");
await writeFile(
  process.env.PI_FILE_TOOLS_CONFIG,
  JSON.stringify({
    version: 1,
    storageRoot: configuredRoot,
    policies: {
      temp: { ttlHours: "6h", maxItems: "16K", maxBytes: "2G" },
      backup: { maxItems: 11, ttlHours: "30d" },
    },
  }),
);
const before = await sourceState(root);
const rounds = [];
try {
  for (const round of [1, 2]) {
    const result = await discoverAndLoadExtensions(
      [path.join(root, "src", "index.ts")],
      root,
      agentDir,
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings ?? [], []);
    const ours = result.extensions.find(
      (extension) =>
        extension.resolvedPath === path.join(root, "src", "index.ts") ||
        extension.path === path.join(root, "src", "index.ts"),
    );
    assert.ok(ours);
    const names = [...ours.tools.keys()].sort();
    assert.deepEqual(names, [
      "backup",
      "copy",
      "mkdir",
      "rename",
      "temp",
      "trash",
    ]);
    assert.equal(ours.tools.has("delete"), false);
    const context = { cwd: agentDir } as ExtensionToolContext;
    const mk = ours.tools.get("mkdir");
    assert.ok(mk);
    const made = await mk.definition.execute(
      `mkdir-${round}`,
      { path: `round-${round}/中文` },
      undefined,
      undefined,
      context,
    );
    assert.ok(made.structuredContent);
    const temp = ours.tools.get("temp");
    assert.ok(temp);
    const allocated = await temp.definition.execute(
      `temp-${round}`,
      {
        action: "create",
        name: `host-${round}.txt`,
        content: "host",
        purpose: "host loader probe",
      },
      undefined,
      undefined,
      context,
    );
    assert.ok(allocated.structuredContent);
    const allocatedResult = allocated.structuredContent as unknown as {
      result: {
        root: string;
        policy: { maxItems: number; maxBytes: number };
        item: { path: string; createdAt: number; expiresAt: number };
      };
    };
    assert.equal(allocatedResult.result.root, configuredRoot);
    assert.equal(allocatedResult.result.policy.maxItems, 16384);
    assert.equal(allocatedResult.result.policy.maxBytes, 2 * 1024 ** 3);
    assert.equal(
      allocatedResult.result.item.expiresAt -
        allocatedResult.result.item.createdAt,
      6 * 3600000,
    );
    const backup = ours.tools.get("backup");
    assert.ok(backup);
    const backupPolicy = await backup.definition.execute(
      `backup-policy-${round}`,
      { action: "policy" },
      undefined,
      undefined,
      context,
    );
    const policyResult = backupPolicy.structuredContent as unknown as {
      result: { current: { maxItems: number }; settingsPath: string };
    };
    assert.equal(policyResult.result.current.maxItems, 11);
    assert.equal(
      policyResult.result.settingsPath,
      process.env.PI_FILE_TOOLS_CONFIG,
    );
    const trash = ours.tools.get("trash");
    assert.ok(trash);
    const listed = await trash.definition.execute(
      `list-${round}`,
      { action: "list", limit: 1 },
      undefined,
      undefined,
      context,
    );
    assert.ok(listed.structuredContent);
    const hooks = ours.handlers.get("before_agent_start");
    assert.equal(hooks?.length, 1);
    const hook = hooks[0] as (
      event: PreflightPromptEvent,
      context: ExtensionToolContext,
    ) => unknown;
    const promptOptions: NonNullable<
      PreflightPromptEvent["systemPromptOptions"]
    > = { sections: { foreign: "KEEP" } };
    const promptEvent = {
      type: "before_agent_start",
      messageType: "user",
      prompt: "Host preflight probe",
      systemPrompt: "HOST PROMPT",
      systemPromptOptions: promptOptions,
    };
    const markerCount = () =>
      (
        promptOptions.forceSystemPrompt ??
        promptOptions.sections?.[PREFLIGHT_SECTION] ??
        ""
      ).split(PREFLIGHT_MARKER).length - 1;
    await hook(promptEvent, context);
    assert.equal(markerCount(), 1);
    await hook(promptEvent, context);
    assert.equal(markerCount(), 1);
    const configFile = process.env.PI_FILE_TOOLS_CONFIG;
    assert.ok(configFile);
    const fixtureSettings = JSON.parse(await readFile(configFile, "utf8"));
    fixtureSettings.preflightPrompt = false;
    await writeFile(configFile, JSON.stringify(fixtureSettings));
    await hook(promptEvent, context);
    assert.equal(markerCount(), 0);
    assert.equal(promptOptions.sections?.foreign, "KEEP");
    fixtureSettings.preflightPrompt = true;
    await writeFile(configFile, JSON.stringify(fixtureSettings));
    promptOptions.forceSystemPrompt = "HOST FORCED PREFIX";
    await hook(promptEvent, context);
    await hook(promptEvent, context);
    assert.equal(markerCount(), 1);
    assert.ok(promptOptions.forceSystemPrompt.startsWith("HOST FORCED PREFIX"));
    fixtureSettings.preflightPrompt = false;
    await writeFile(configFile, JSON.stringify(fixtureSettings));
    await hook(promptEvent, context);
    assert.equal(promptOptions.forceSystemPrompt, "HOST FORCED PREFIX");
    fixtureSettings.preflightPrompt = true;
    await writeFile(configFile, JSON.stringify(fixtureSettings));
    assert.equal(
      await readFile(agentRulesFile, "utf8"),
      "HOST PROJECT RULES\n",
    );
    const entry = {
      round,
      tools: names,
      schemas: Object.fromEntries(
        [...ours.tools].map(([name, tool]) => [
          name,
          {
            parameters: tool.definition.parameters,
            outputSchema: tool.definition.outputSchema,
          },
        ]),
      ),
      errors: result.errors,
      warnings: result.warnings ?? [],
      hostVersion: "1.6.0",
      modelRequests: 0,
      executed: [
        "mkdir",
        "temp:create",
        "backup:policy",
        "trash:list",
        "before_agent_start:preflight:on-off",
      ],
      preflightVerified: {
        registered: true,
        enabledBeforeToggle: true,
        hotToggle: true,
        idempotent: true,
        forcedPromptFallback: true,
        agentsFileUnchanged: true,
        scope: "actual loaded callback with in-memory event; no model request",
      },
      settingsVerified: {
        storageRoot: configuredRoot,
        tempTtlHours: 6,
        tempMaxItems: 16384,
        backupMaxItems: 11,
      },
    };
    rounds.push(entry);
    console.log(JSON.stringify({ ...entry, schemas: "recorded in receipt" }));
  }
  const after = await sourceState(root);
  assert.equal(
    after.inputDigest,
    before.inputDigest,
    "source inputs unchanged during host checks",
  );
  const folder = path.join(
    root,
    "verification",
    "runs",
    `host-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "receipt.json"),
    JSON.stringify(
      { status: "passed", inputDigest: before.inputDigest, rounds },
      null,
      2,
    ),
  );
} finally {
  if (previousManagedHome === undefined) delete process.env.PI_FILE_TOOLS_HOME;
  else process.env.PI_FILE_TOOLS_HOME = previousManagedHome;
  if (previousManagedConfig === undefined)
    delete process.env.PI_FILE_TOOLS_CONFIG;
  else process.env.PI_FILE_TOOLS_CONFIG = previousManagedConfig;
  await rm(agentDir, { recursive: true, force: false });
}
