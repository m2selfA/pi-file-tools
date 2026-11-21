import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerFileTools } from "../src/index.js";
import { fixture } from "./support.js";

function registrationApi(
  tools: ToolDefinition[],
  handlers?: Map<string, unknown>,
): ExtensionAPI {
  return {
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool);
    },
    on: (event: string, handler: unknown) => {
      handlers?.set(event, handler);
    },
  } as unknown as ExtensionAPI;
}
test("register exactly six tools, strict schemas and no delete", async (t) => {
  const { root, backend } = await fixture(t);
  const tools: ToolDefinition[] = [];
  registerFileTools(registrationApi(tools), backend, {
    root: path.join(root, "managed"),
  });
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "backup",
    "copy",
    "mkdir",
    "rename",
    "temp",
    "trash",
  ]);
  for (const tool of tools) {
    const schema = tool.parameters as unknown as {
      additionalProperties?: unknown;
      properties?: Record<string, unknown>;
    };
    assert.equal(schema.additionalProperties, false);
    assert.ok(tool.outputSchema);
    assert.ok(tool.promptGuidelines?.every((rule) => rule.includes(tool.name)));
  }
  const rename = tools.find((tool) => tool.name === "rename");
  assert.ok(rename);
  assert.equal(
    "recursive" in
      (rename.parameters as unknown as { properties: Record<string, unknown> })
        .properties,
    false,
  );
});
test("registers session maintenance lifecycle handlers", async (t) => {
  const { root, backend } = await fixture(t);
  const handlers = new Map<string, unknown>();
  registerFileTools(registrationApi([], handlers), backend, {
    root: path.join(root, "managed"),
  });
  assert.ok(handlers.has("session_start"));
  assert.ok(handlers.has("session_shutdown"));
});

test("session start schedules maintenance and shutdown clears it", async (t) => {
  const { root, backend } = await fixture(t);
  const handlers = new Map<string, unknown>();
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let scheduled = 0;
  let cleared = 0;
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    scheduled += 1;
    assert.equal(delay, 15 * 60 * 1000);
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {
    cleared += 1;
  }) as typeof clearInterval;
  try {
    registerFileTools(registrationApi([], handlers), backend, {
      root: path.join(root, "managed"),
    });
    const start = handlers.get("session_start") as (
      event: unknown,
      context: unknown,
    ) => Promise<void>;
    const shutdown = handlers.get("session_shutdown") as () => void;
    await start({}, { hasUI: false });
    assert.equal(scheduled, 1);
    shutdown();
    assert.equal(cleared, 1);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("partial empty failure is an error with structured details", async (t) => {
  const { root, backend } = await fixture(t);
  await writeFile(path.join(root, "a"), "a");
  const item = await backend.put(path.join(root, "a"));
  backend.purge = async (ids) => ({
    removed: [],
    failed: ids.map((id) => ({ id, error: "injected purge failure" })),
  });
  const tools: ToolDefinition[] = [];
  registerFileTools(registrationApi(tools), backend, {
    root: path.join(root, "managed"),
  });
  const trash = tools.find((tool) => tool.name === "trash");
  assert.ok(trash);
  const result = await trash.execute(
    "test",
    { action: "empty", ids: [item.id], confirm: "EMPTY" },
    undefined,
    undefined,
    { cwd: root } as ExtensionToolContext,
  );
  assert.equal(result.isError, true);
  assert.ok(result.structuredContent);
  assert.equal((await backend.list()).length, 1);
});
