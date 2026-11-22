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
import { ManagedStore } from "../src/managed/store.js";
import { LOCAL_SCOPE } from "../src/scope.js";
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
test("all six tools declare controller-local scope and managed SSH boundaries", async (t) => {
  const { root, backend } = await fixture(t);
  const tools: ToolDefinition[] = [];
  registerFileTools(registrationApi(tools), backend, {
    root: path.join(root, "managed"),
  });
  assert.equal(tools.length, 6);
  for (const tool of tools)
    assert.ok((tool.description ?? "").includes(LOCAL_SCOPE), tool.name);
  const temp = tools.find((tool) => tool.name === "temp");
  assert.ok(temp);
  assert.ok(
    temp.promptGuidelines?.some((rule) =>
      rule.includes("When an SSH target is active"),
    ),
  );
  assert.ok(
    temp.promptGuidelines?.some((rule) =>
      rule.includes("do not pass it to ssh_write"),
    ),
  );
  const backup = tools.find((tool) => tool.name === "backup");
  assert.ok(backup);
  assert.ok(
    backup.promptGuidelines?.some((rule) =>
      rule.includes("never reads through SSH"),
    ),
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

test("failed first maintenance still schedules a retry and shutdown cleanup", async (t) => {
  const { root, backend } = await fixture(t);
  const handlers = new Map<string, unknown>();
  const original = {
    maintain: ManagedStore.prototype.maintain,
    set: globalThis.setInterval,
    clear: globalThis.clearInterval,
    error: console.error,
  };
  let scheduled = 0;
  let cleared = 0;
  let attempts = 0;
  let callback: (() => void) | undefined;
  const messages: string[] = [];
  const notifications: { message: string; kind: string }[] = [];
  globalThis.setInterval = ((fn: () => void) => {
    scheduled++;
    callback = fn;
    return { unref() {} } as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {
    cleared++;
  }) as typeof clearInterval;
  console.error = (...args: unknown[]) => {
    messages.push(args.join(" "));
  };
  ManagedStore.prototype.maintain = async () => {
    attempts++;
    if (attempts === 1) throw new Error("injected first sweep failure");
    return { failed: [], status: "ok" };
  };
  try {
    registerFileTools(registrationApi([], handlers), backend, {
      root: path.join(root, "managed"),
    });
    const start = handlers.get("session_start") as (
      e: unknown,
      c: unknown,
    ) => Promise<void>;
    await start(
      {},
      {
        hasUI: true,
        ui: {
          notify: (message: string, kind: string) =>
            notifications.push({ message, kind }),
        },
      },
    );
    assert.equal(scheduled, 1);
    assert.equal(attempts, 1);
    assert.ok(messages.some((s) => s.includes("injected first sweep failure")));
    assert.equal(notifications[0].kind, "warning");
    assert.ok(callback);
    callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2);
    (handlers.get("session_shutdown") as () => void)();
    assert.equal(cleared, 1);
  } finally {
    ManagedStore.prototype.maintain = original.maintain;
    globalThis.setInterval = original.set;
    globalThis.clearInterval = original.clear;
    console.error = original.error;
  }
});

test("partial startup maintenance is a warning rather than a ready notification", async (t) => {
  const { root, backend } = await fixture(t);
  const handlers = new Map<string, unknown>();
  const original = {
    maintain: ManagedStore.prototype.maintain,
    set: globalThis.setInterval,
    clear: globalThis.clearInterval,
    warn: console.warn,
  };
  const notifications: string[] = [];
  const warnings: string[] = [];
  globalThis.setInterval = (() => ({
    unref() {},
  })) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  ManagedStore.prototype.maintain = async () => ({
    status: "partial",
    failed: [{ id: "fixture-blocked", error: "inspection failed" }],
  });
  try {
    registerFileTools(registrationApi([], handlers), backend, {
      root: path.join(root, "managed"),
    });
    await (
      handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>
    )(
      {},
      {
        hasUI: true,
        ui: {
          notify: (_message: string, kind: string) => notifications.push(kind),
        },
      },
    );
    assert.deepEqual(notifications, ["warning"]);
    assert.ok(warnings.some((s) => s.includes("fixture-blocked")));
    (handlers.get("session_shutdown") as () => void)();
  } finally {
    ManagedStore.prototype.maintain = original.maintain;
    globalThis.setInterval = original.set;
    globalThis.clearInterval = original.clear;
    console.warn = original.warn;
  }
});

test("non-blocking session_start aborts on shutdown and avoids raw stderr in TUI mode", async (t) => {
  const { root, backend } = await fixture(t);
  const handlers = new Map<string, unknown>();
  const original = {
    maintain: ManagedStore.prototype.maintain,
    set: globalThis.setInterval,
    clear: globalThis.clearInterval,
    error: console.error,
    warn: console.warn,
  };
  let aborted = false;
  let resolveMaintain!: () => void;
  const maintainGate = new Promise<void>((resolve) => {
    resolveMaintain = resolve;
  });
  const errors: string[] = [];
  const warnings: string[] = [];
  const notifications: { message: string; kind: string }[] = [];
  globalThis.setInterval = (() => ({
    unref() {},
  })) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  ManagedStore.prototype.maintain = async (_owner, options) => {
    options?.signal?.addEventListener("abort", () => {
      aborted = true;
    });
    await maintainGate;
    return { status: "ok", failed: [] };
  };
  try {
    registerFileTools(registrationApi([], handlers), backend, {
      root: path.join(root, "managed"),
    });
    const start = handlers.get("session_start") as (
      e: unknown,
      c: unknown,
    ) => Promise<void>;
    const shutdown = handlers.get("session_shutdown") as () => Promise<void>;
    const t0 = Date.now();
    await start(
      {},
      {
        mode: "tui",
        hasUI: true,
        ui: {
          notify: (message: string, kind: string) =>
            notifications.push({ message, kind }),
        },
      },
    );
    assert.ok(
      Date.now() - t0 < 200,
      "session_start must not block on maintain",
    );
    await shutdown();
    assert.equal(aborted, true);
    resolveMaintain();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(notifications.length, 0);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
  } finally {
    ManagedStore.prototype.maintain = original.maintain;
    globalThis.setInterval = original.set;
    globalThis.clearInterval = original.clear;
    console.error = original.error;
    console.warn = original.warn;
  }
});

test("TUI mode suppresses raw console.error/warn while non-TUI logs them", async (t) => {
  const { root, backend } = await fixture(t);
  const handlers = new Map<string, unknown>();
  const original = {
    maintain: ManagedStore.prototype.maintain,
    set: globalThis.setInterval,
    clear: globalThis.clearInterval,
    error: console.error,
  };
  const errors: string[] = [];
  const notifications: { message: string; kind: string }[] = [];
  globalThis.setInterval = (() => ({
    unref() {},
  })) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  console.error = (...args: unknown[]) => errors.push(args.join(" "));
  ManagedStore.prototype.maintain = async () => {
    throw new Error("tui-safe-error");
  };
  try {
    registerFileTools(registrationApi([], handlers), backend, {
      root: path.join(root, "managed"),
    });
    const start = handlers.get("session_start") as (
      e: unknown,
      c: unknown,
    ) => Promise<void>;
    const shutdown = handlers.get("session_shutdown") as () => Promise<void>;
    await start(
      {},
      {
        mode: "tui",
        hasUI: true,
        ui: {
          notify: (message: string, kind: string) =>
            notifications.push({ message, kind }),
        },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(errors.length, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].kind, "warning");
    await shutdown();
  } finally {
    ManagedStore.prototype.maintain = original.maintain;
    globalThis.setInterval = original.set;
    globalThis.clearInterval = original.clear;
    console.error = original.error;
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
