import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FileOperations } from "./files.js";
import { managedSchema } from "./managed/index.js";
import type { Category } from "./managed/model.js";
import type { SessionIdentity } from "./managed/sessions.js";
import type { ManagedInput, StoreOptions } from "./managed/store.js";
import { ManagedStore } from "./managed/store.js";
import { registerPreflightPrompt } from "./prompt-guidance.js";
import { LOCAL_SCOPE } from "./scope.js";
import { createTrashBackend } from "./trash/index.js";
import { serializedBackend, TrashOperations } from "./trash/service.js";
import type { OperationResult, TrashBackend } from "./types.js";

const pathSchema = () =>
  Type.String({
    minLength: 1,
    description:
      "Path relative to the local Pi ctx.cwd, or absolute. A leading @ is accepted.",
  });
const outputSchema = Type.Object({
  operation: Type.String(),
  result: Type.Record(Type.String(), Type.Unknown()),
});
function response(operation: string, result: OperationResult) {
  type Json =
    | null
    | boolean
    | number
    | string
    | Json[]
    | { [key: string]: Json };
  const structuredContent = JSON.parse(
    JSON.stringify({ operation, result }),
  ) as { [key: string]: Json };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    details: structuredContent,
    structuredContent,
    ...(Array.isArray(result.failed) && result.failed.length
      ? { isError: true }
      : {}),
  };
}

interface SessionContextLike {
  cwd?: string;
  mode?: string;
  hasUI?: boolean;
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
    getSessionName?: () => string | undefined;
  };
}

function sessionFromContext(
  ctx?: SessionContextLike,
): SessionIdentity | undefined {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (!ctx || !sessionId) return undefined;
  return {
    sessionId,
    sessionFile: ctx.sessionManager?.getSessionFile?.(),
    sessionName: ctx.sessionManager?.getSessionName?.(),
    cwd: ctx.cwd,
  };
}

function isInteractiveTui(ctx?: SessionContextLike): boolean {
  return ctx?.hasUI === true && ctx?.mode === "tui";
}

/** Backend injection is for deterministic unit tests; normal Pi loading uses the OS backend. */
export function registerFileTools(
  pi: ExtensionAPI,
  backend: TrashBackend = createTrashBackend(),
  options: StoreOptions = {},
): void {
  const trash = serializedBackend(backend);
  const files = new FileOperations(trash);
  const recycle = new TrashOperations(trash);
  const managed = new ManagedStore(trash, { ...options, files });
  if (typeof pi.on === "function")
    registerPreflightPrompt(pi, managed.settingsPath);
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sessionAbort: AbortController | undefined;
  let activeSession: SessionIdentity | undefined;
  let latestContext: SessionContextLike | undefined;

  const managedTool = (category: Category, label: string) => ({
    name: category,
    label,
    executionMode: "sequential" as const,
    description: `${LOCAL_SCOPE} ${category === "backup" ? "Store recoverable snapshots" : "Allocate centrally managed temporary files or directories"}. Actions: create, list, inspect, restore, release, cleanup, policy, pin, touch. Storage and retention are configured in file-tools.json under the Pi agent directory (or PI_FILE_TOOLS_CONFIG); PI_FILE_TOOLS_HOME overrides the storage root, and a leading ~ resolves to the user home. Cleanup defaults to dry-run, respects leases and pins, moves items to the OS trash first, and reports physicalBytesFreed:null until the recorded purge window passes.`,
    promptSnippet: `${category} management with preview, retention and recovery`,
    promptGuidelines: [
      `Use ${category} action:create before producing ${category === "backup" ? "a recoverable copy" : "temporary output"}; do not write managed paths outside the returned path.`,
      ...(category === "backup"
        ? [
            "When an SSH target is active, backup still manages controller-local files; use ssh_bash, ssh_upload, or ssh_download for remote files.",
            "backup never reads through SSH; download a remote directory before creating its backup.",
          ]
        : [
            "When an SSH target is active, temp still manages controller-local files; use ssh_bash, ssh_upload, or ssh_download for remote files.",
            "temp returns a controller-local path even while SSH is active; do not pass it to ssh_write as a remote path.",
          ]),
      `Use ${category} action:cleanup without execute first; set execute:true only after reviewing the exact plan.`,
      `Use ${category} action:release for one item; active leases and pinned items are protected from automatic cleanup.`,
      `Use ${category} action:restore with the exact id; existing destinations are never overwritten.`,
    ],
    parameters: managedSchema(category),
    outputSchema,
    async execute(
      _id: string,
      input: unknown,
      signal: AbortSignal | undefined,
      _update: unknown,
      ctx: SessionContextLike & { cwd: string },
    ) {
      const session = sessionFromContext(ctx);
      if (session) activeSession = session;
      const owner = session?.sessionId ? `pi:${session.sessionId}` : "pi";
      return response(
        category,
        await managed.execute(
          category,
          input as ManagedInput,
          ctx.cwd,
          owner,
          signal,
          { session },
        ),
      );
    },
  });
  pi.registerTool(managedTool("backup", "Managed backups"));
  pi.registerTool(managedTool("temp", "Managed temporary files"));

  const reportMaintenance = (
    result: OperationResult,
    ctx?: SessionContextLike,
  ): string | undefined => {
    const failed = Array.isArray(result.failed)
      ? (result.failed as { id: string; error: string }[])
      : [];
    if (!failed.length) return undefined;
    const message = `Managed maintenance partial: ${failed.length} item(s) need attention; inspect ${failed
      .slice(0, 8)
      .map((i) => i.id)
      .join(", ")} before retrying.`;
    if (!isInteractiveTui(ctx)) console.warn(`[pi-file-tools] ${message}`);
    return message;
  };

  const runMaintenance = async (
    trigger: "startup" | "timer",
    ctx: SessionContextLike | undefined,
    signal: AbortSignal,
  ): Promise<void> => {
    const session = sessionFromContext(ctx) ?? activeSession;
    if (session) activeSession = session;
    const owner = session?.sessionId ? `pi:${session.sessionId}` : "pi-session";
    try {
      const result = await managed.maintain(owner, {
        background: true,
        signal,
        maxActions: 10,
        session,
      });
      if (signal.aborted) return;
      if (result.skipped) return;
      const warning = reportMaintenance(result, ctx);
      if (ctx?.hasUI && (warning || trigger === "startup"))
        ctx.ui?.notify(
          warning ?? `Managed backup/temp sweep ready at ${managed.root}`,
          warning ? "warning" : "info",
        );
    } catch (error) {
      if (signal.aborted) return;
      const message = `Managed maintenance failed; inspect recorded state before retrying: ${error instanceof Error ? error.message : String(error)}`;
      if (!isInteractiveTui(ctx)) console.error(`[pi-file-tools] ${message}`);
      if (ctx?.hasUI) ctx.ui?.notify(message, "warning");
    } finally {
      if (!signal.aborted && session)
        await managed.touchSessionHeartbeat(session).catch(() => {});
    }
  };

  if (typeof pi.on === "function")
    pi.on("session_start", async (_event, ctx) => {
      const context = ctx as SessionContextLike | undefined;
      latestContext = context;
      sessionAbort?.abort();
      const controller = new AbortController();
      sessionAbort = controller;
      activeSession = sessionFromContext(context);
      // A failed or skipped first sweep must not block startup or prevent later retries.
      if (sweepTimer === undefined) {
        sweepTimer = setInterval(
          () => {
            const signal = sessionAbort?.signal;
            if (signal) void runMaintenance("timer", latestContext, signal);
          },
          15 * 60 * 1000,
        );
        sweepTimer.unref?.();
      }
      void runMaintenance("startup", context, controller.signal);
    });
  if (typeof pi.on === "function")
    pi.on("session_shutdown", async () => {
      sessionAbort?.abort();
      sessionAbort = undefined;
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      const session = activeSession;
      activeSession = undefined;
      latestContext = undefined;
      if (session?.sessionId)
        await managed.endSession(session.sessionId).catch(() => undefined);
    });
  pi.registerTool({
    name: "mkdir",
    label: "Create directory",
    description: `${LOCAL_SCOPE} Create a directory and missing parents by default. Existing directories are reported; an existing file or symlink is an error.`,
    promptSnippet: "Create directories recursively",
    promptGuidelines: [
      "Use mkdir to create empty directories; recursive defaults to true.",
    ],
    parameters: Type.Object(
      { path: pathSchema(), recursive: Type.Optional(Type.Boolean()) },
      { additionalProperties: false },
    ),
    outputSchema,
    async execute(_id, input, signal, _update, ctx) {
      return response(
        "mkdir",
        await files.mkdir(input.path, ctx.cwd, input.recursive ?? true, signal),
      );
    },
  });
  for (const kind of ["copy", "rename"] as const) {
    pi.registerTool({
      name: kind,
      label: kind,
      description: `${LOCAL_SCOPE} ${kind === "copy" ? "Copy" : "Move"} a file, symlink or directory to an exact destination. Parent must exist. Existing destinations require overwrite:true and are first moved to the OS trash; the result includes their restore id.${kind === "copy" ? " Directories require recursive:true." : " Cross-volume rename is refused."}`,
      promptSnippet: `${kind} files and directories; preserve overwritten targets in trash`,
      promptGuidelines: [
        `Use ${kind} with overwrite:true only when replacing the destination is intended; the replaced item stays recoverable in the OS trash.`,
        ...(kind === "copy"
          ? ["Use copy with recursive:true for directory sources."]
          : []),
      ],
      parameters: Type.Object(
        {
          source: pathSchema(),
          destination: pathSchema(),
          ...(kind === "copy"
            ? { recursive: Type.Optional(Type.Boolean()) }
            : {}),
          overwrite: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      outputSchema,
      async execute(_id, input, signal, _update, ctx) {
        return response(
          kind,
          await files.transfer(
            kind,
            {
              source: input.source,
              destination: input.destination,
              overwrite: input.overwrite,
              recursive: kind === "copy" && input.recursive === true,
            },
            ctx.cwd,
            signal,
          ),
        );
      },
    });
  }
  pi.registerTool({
    name: "trash",
    label: "Recycle Bin",
    executionMode: "sequential",
    description: `${LOCAL_SCOPE} Manage the real OS Recycle Bin/trash. action: put (path; non-empty directories need recursive:true), list (offset, limit <=200), restore (exact id; optional destination; never overwrite), empty (ids OR all:true; requires confirm:"EMPTY"; permanent; <=256 entries). all:true empties a snapshot of the entire current-user bin, including unrelated items. No permanent-delete fallback for put.`,
    promptSnippet:
      "Move items to OS trash, list, restore, or explicitly empty selected recycled items",
    promptGuidelines: [
      "Use trash action:put instead of permanent deletion; retain its returned id for recovery.",
      "Use trash action:restore with the exact id returned by trash; restore never overwrites an existing destination.",
      'Use trash action:empty only for explicitly authorized permanent removal, with exact ids and confirm:"EMPTY". Use all:true only when the user explicitly wants the entire system bin emptied.',
    ],
    parameters: Type.Object(
      {
        action: Type.String({ enum: ["put", "list", "restore", "empty"] }),
        path: Type.Optional(pathSchema()),
        id: Type.Optional(Type.String({ minLength: 1 })),
        ids: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), {
            minItems: 1,
            maxItems: 256,
            uniqueItems: true,
          }),
        ),
        destination: Type.Optional(pathSchema()),
        recursive: Type.Optional(Type.Boolean()),
        all: Type.Optional(Type.Boolean()),
        confirm: Type.Optional(Type.Literal("EMPTY")),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      },
      { additionalProperties: false },
    ),
    outputSchema,
    async execute(_id, input, signal, _update, ctx) {
      return response(
        "trash",
        await recycle.execute(
          input as Parameters<TrashOperations["execute"]>[0],
          ctx.cwd,
          signal,
        ),
      );
    },
  });
}
export default function fileTools(pi: ExtensionAPI): void {
  registerFileTools(pi);
}
