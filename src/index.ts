import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FileOperations } from "./files.js";
import { managedSchema } from "./managed/index.js";
import type { Category } from "./managed/model.js";
import type { ManagedInput, StoreOptions } from "./managed/store.js";
import { ManagedStore } from "./managed/store.js";
import { createTrashBackend } from "./trash/index.js";
import { serializedBackend, TrashOperations } from "./trash/service.js";
import type { OperationResult, TrashBackend } from "./types.js";

const pathSchema = () =>
  Type.String({
    minLength: 1,
    description:
      "Path relative to ctx.cwd, or absolute. A leading @ is accepted.",
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
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  const managedTool = (category: Category, label: string) => ({
    name: category,
    label,
    executionMode: "sequential" as const,
    description: `${category === "backup" ? "Store recoverable snapshots" : "Allocate centrally managed temporary files or directories"}. Actions: create, list, inspect, restore, release, cleanup, policy, pin, touch. Storage and retention are configured in file-tools.json under the Pi agent directory (or PI_FILE_TOOLS_CONFIG); PI_FILE_TOOLS_HOME overrides the storage root, and a leading ~ resolves to the user home. Cleanup defaults to dry-run, respects leases and pins, moves items to the OS trash first, and reports physicalBytesFreed:null until the recorded purge window passes.`,
    promptSnippet: `${category} management with preview, retention and recovery`,
    promptGuidelines: [
      `Use ${category} action:create before producing ${category === "backup" ? "a recoverable copy" : "temporary output"}; do not write managed paths outside the returned path.`,
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
      ctx: { cwd: string },
    ) {
      return response(
        category,
        await managed.execute(
          category,
          input as ManagedInput,
          ctx.cwd,
          "pi",
          signal,
        ),
      );
    },
  });
  pi.registerTool(managedTool("backup", "Managed backups"));
  pi.registerTool(managedTool("temp", "Managed temporary files"));
  if (typeof pi.on === "function")
    pi.on("session_start", async (_event, ctx) => {
      await managed.maintain("pi-session");
      if (sweepTimer === undefined) {
        sweepTimer = setInterval(
          () => {
            void managed
              .maintain("pi-session")
              .catch((error) =>
                console.error(
                  `[pi-file-tools] managed sweep failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
              );
          },
          15 * 60 * 1000,
        );
        sweepTimer.unref?.();
      }
      if (ctx.hasUI)
        ctx.ui.notify(
          `Managed backup/temp sweep ready at ${managed.root}`,
          "info",
        );
    });
  if (typeof pi.on === "function")
    pi.on("session_shutdown", () => {
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
    });
  pi.registerTool({
    name: "mkdir",
    label: "Create directory",
    description:
      "Create a directory and missing parents by default. Existing directories are reported; an existing file or symlink is an error.",
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
      description: `${kind === "copy" ? "Copy" : "Move"} a file, symlink or directory to an exact destination. Parent must exist. Existing destinations require overwrite:true and are first moved to the OS trash; the result includes their restore id.${kind === "copy" ? " Directories require recursive:true." : " Cross-volume rename is refused."}`,
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
    description:
      'Manage the real OS Recycle Bin/trash. action: put (path; non-empty directories need recursive:true), list (offset, limit <=200), restore (exact id; optional destination; never overwrite), empty (ids OR all:true; requires confirm:"EMPTY"; permanent; <=256 entries). all:true empties a snapshot of the entire current-user bin, including unrelated items. No permanent-delete fallback for put.',
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
