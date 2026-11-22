import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
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
import { LOCAL_SCOPE } from "../src/scope.js";
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
    const descriptionsScoped = [...ours.tools].every(([, tool]) =>
      (tool.definition.description ?? "").includes(LOCAL_SCOPE),
    );
    assert.equal(descriptionsScoped, true);
    const tempRules = ours.tools.get("temp")?.definition.promptGuidelines ?? [];
    const backupRules =
      ours.tools.get("backup")?.definition.promptGuidelines ?? [];
    const tempSshGuidance =
      tempRules.some((rule) => rule.includes("When an SSH target is active")) &&
      tempRules.some((rule) => rule.includes("do not pass it to ssh_write"));
    const backupSshGuidance = backupRules.some((rule) =>
      rule.includes("never reads through SSH"),
    );
    assert.equal(tempSshGuidance, true);
    assert.equal(backupSshGuidance, true);
    const sessionId = `host-session-${round}`;
    const context = {
      cwd: agentDir,
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => path.join(agentDir, `${sessionId}.jsonl`),
        getSessionName: () => `Host Round ${round}`,
      },
    } as unknown as ExtensionToolContext;
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
    const sessionList = await temp.definition.execute(
      `temp-list-session-${round}`,
      { action: "list", scope: "session" },
      undefined,
      undefined,
      context,
    );
    const sessionListResult = sessionList.structuredContent as unknown as {
      result: {
        scope: string;
        currentSessionId: string;
        items: { sessionId?: string }[];
      };
    };
    assert.equal(sessionListResult.result.scope, "session");
    assert.equal(sessionListResult.result.currentSessionId, sessionId);
    assert.ok(
      sessionListResult.result.items.length >= 1 &&
        sessionListResult.result.items.every((i) => i.sessionId === sessionId),
    );
    const sessionHeartbeat = path.join(
      configuredRoot,
      "sessions",
      `${sessionId}.json`,
    );
    assert.equal(
      JSON.parse(await readFile(sessionHeartbeat, "utf8")).sessionId,
      sessionId,
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
    const linked = await temp.definition.execute(
      `linked-${round}`,
      {
        action: "create",
        kind: "directory",
        name: `linked-${round}`,
        purpose: "startup nested-link fixture",
      },
      undefined,
      undefined,
      context,
    );
    const linkedItem = (
      linked.structuredContent as unknown as {
        result: { item: { id: string; path: string } };
      }
    ).result.item;
    const outsideSdk = path.join(agentDir, `outside-sdk-${round}`);
    await mkdir(outsideSdk);
    await writeFile(path.join(outsideSdk, "keep.txt"), "KEEP SDK TARGET");
    await mkdir(path.join(linkedItem.path, "node_modules"));
    await symlink(
      outsideSdk,
      path.join(linkedItem.path, "node_modules", "@earendil-works"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const damaged = await temp.definition.execute(
      `damaged-${round}`,
      {
        action: "create",
        name: `damaged-${round}`,
        content: "repair me",
        purpose: "startup isolated inspection error",
      },
      undefined,
      undefined,
      context,
    );
    const damagedItem = (
      damaged.structuredContent as unknown as {
        result: { item: { id: string; path: string } };
      }
    ).result.item;
    await unlink(damagedItem.path);
    const startHooks = ours.handlers.get("session_start");
    const stopHooks = ours.handlers.get("session_shutdown");
    assert.equal(startHooks?.length, 1);
    assert.equal(stopHooks?.length, 1);
    const start = startHooks[0] as (
      event: unknown,
      ctx: unknown,
    ) => Promise<void>;
    const stop = stopHooks[0] as (
      event: unknown,
      ctx: unknown,
    ) => Promise<void>;
    const originalWarn = console.warn;
    const maintenanceWarnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      maintenanceWarnings.push(args.join(" "));
    };
    const waitFor = async (
      predicate: () => Promise<boolean> | boolean,
      timeoutMs = 5000,
    ) => {
      const deadline = Date.now() + timeoutMs;
      while (!(await predicate())) {
        if (Date.now() >= deadline)
          throw new Error("Timed out waiting for background startup sweep.");
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    };
    const configFile = process.env.PI_FILE_TOOLS_CONFIG;
    assert.ok(configFile);
    const savedSettings = JSON.parse(await readFile(configFile, "utf8"));
    savedSettings.sweepCooldownMinutes = 0;
    await writeFile(configFile, JSON.stringify(savedSettings));
    try {
      const t0 = Date.now();
      await start({ type: "session_start" }, { cwd: agentDir, hasUI: false });
      assert.ok(Date.now() - t0 < 1000, "session_start must stay non-blocking");
      await waitFor(() => maintenanceWarnings.length === 1);
      assert.ok(maintenanceWarnings[0].includes(damagedItem.id));
      const inspectDamage = await temp.definition.execute(
        `inspect-damage-${round}`,
        { action: "inspect", id: damagedItem.id },
        undefined,
        undefined,
        context,
      );
      const damagedState = (
        inspectDamage.structuredContent as unknown as {
          result: { item: { state: string; inspectionError?: string } };
        }
      ).result.item;
      assert.equal(damagedState.state, "active");
      assert.ok(damagedState.inspectionError);
      await writeFile(damagedItem.path, "repair me");
      await start({ type: "session_start" }, { cwd: agentDir, hasUI: false });
      await waitFor(async () => {
        const res = await temp.definition.execute(
          `inspect-repaired-${round}`,
          { action: "inspect", id: damagedItem.id },
          undefined,
          undefined,
          context,
        );
        const item = (
          res.structuredContent as unknown as {
            result: { item: { inspectionError?: string } };
          }
        ).result.item;
        return item.inspectionError === undefined;
      });
      assert.equal(maintenanceWarnings.length, 1);
      const healthy = await temp.definition.execute(
        `inspect-link-${round}`,
        { action: "inspect", id: linkedItem.id },
        undefined,
        undefined,
        context,
      );
      const linkState = (
        healthy.structuredContent as unknown as {
          result: { item: { linkCount: number; inspectionError?: string } };
        }
      ).result.item;
      assert.equal(linkState.linkCount, 1);
      assert.equal(linkState.inspectionError, undefined);
      assert.equal(
        await readFile(path.join(outsideSdk, "keep.txt"), "utf8"),
        "KEEP SDK TARGET",
      );
      savedSettings.sweepCooldownMinutes = 5;
      await writeFile(configFile, JSON.stringify(savedSettings));
      await start({ type: "session_start" }, context);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(maintenanceWarnings.length, 1);
    } finally {
      console.warn = originalWarn;
      await stop({ type: "session_shutdown" }, { cwd: agentDir, hasUI: false });
    }
    await assert.rejects(readFile(sessionHeartbeat, "utf8"));
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
    const preflightText = promptOptions.sections?.[PREFLIGHT_SECTION] ?? "";
    assert.match(preflightText, /controller-local filesystem/);
    await hook(promptEvent, context);
    assert.equal(markerCount(), 1);
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
      scopeVerified: {
        allSixToolDescriptions: descriptionsScoped,
        preflightSection: /controller-local filesystem/.test(preflightText),
        tempSshGuidance,
        backupSshGuidance,
        scope:
          "loaded tool metadata and actual before_agent_start callback; no model request",
      },
      preflightVerified: {
        registered: true,
        enabledBeforeToggle: true,
        hotToggle: true,
        idempotent: true,
        forcedPromptFallback: true,
        agentsFileUnchanged: true,
        scope: "actual loaded callback with in-memory event; no model request",
      },
      multiSessionVerified: {
        sessionIdRecorded: true,
        sessionHeartbeatCreatedAndRemoved: true,
        sessionScopeFiltered: true,
        nonBlockingStartup: true,
        cooldownSkipVerified: true,
        scope: "actual loaded extension with sessionManager context",
      },
      startupIsolationVerified: {
        nestedLinkScannedWithoutDereference: true,
        oneBlockedItemReported: true,
        mutationStatePreserved: true,
        recoveryOnNextSweep: true,
        timerShutdownInvoked: true,
        externalTargetUnchanged: true,
        scope: "actual loaded startup callback against isolated fixtures",
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
