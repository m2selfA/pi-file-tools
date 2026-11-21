import path from "node:path";
import { exists, locked, protect, resolvePath } from "../paths.js";
import {
  checkAbort,
  type OperationResult,
  type TrashBackend,
} from "../types.js";

export interface TrashInput {
  action: "put" | "list" | "restore" | "empty";
  path?: string;
  id?: string;
  ids?: string[];
  destination?: string;
  recursive?: boolean;
  all?: boolean;
  confirm?: string;
  offset?: number;
  limit?: number;
}

/** Serialize backend calls, including those made by copy/rename overwrite. */
export function serializedBackend(backend: TrashBackend): TrashBackend {
  let tail = Promise.resolve();
  function run<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  return {
    name: backend.name,
    put: (value) => run(() => backend.put(value)),
    list: () => run(() => backend.list()),
    restore: (id, destination) => run(() => backend.restore(id, destination)),
    purge: (ids) => run(() => backend.purge(ids)),
  };
}

export class TrashOperations {
  constructor(private readonly backend: TrashBackend) {}
  async execute(
    input: TrashInput,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    const allowed: Record<TrashInput["action"], string[]> = {
      put: ["action", "path", "recursive"],
      list: ["action", "offset", "limit"],
      restore: ["action", "id", "destination"],
      empty: ["action", "ids", "all", "confirm"],
    };
    if (!allowed[input.action]) throw new Error("Unknown trash action.");
    for (const key of Object.keys(input))
      if (!allowed[input.action].includes(key))
        throw new Error(
          `Parameter ${key} does not apply to trash ${input.action}.`,
        );
    checkAbort(signal);
    if (input.action === "put") {
      const target = resolvePath(input.path, cwd);
      return locked(
        [target],
        async () => {
          await protect(target, cwd);
          const { lstat, readdir } = await import("node:fs/promises");
          const info = await lstat(target);
          if (
            info.isDirectory() &&
            !input.recursive &&
            (await readdir(target)).length
          )
            throw new Error("Non-empty directories require recursive: true.");
          checkAbort(signal);
          const item = await this.backend.put(target);
          if (await exists(target))
            throw new Error(
              "Trash returned but source still exists; inspect both locations before retrying.",
            );
          return { action: "put", backend: this.backend.name, item };
        },
        signal,
      );
    }
    if (input.action === "list") {
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 100;
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        throw new Error(
          "List requires offset >= 0 and limit 1..200 (integers).",
        );
      const items = (await this.backend.list()).sort(
        (a, b) =>
          b.deletedAt.localeCompare(a.deletedAt) || a.id.localeCompare(b.id),
      );
      return {
        action: "list",
        backend: this.backend.name,
        total: items.length,
        offset,
        items: items.slice(offset, offset + limit),
        nextOffset: offset + limit < items.length ? offset + limit : null,
      };
    }
    if (input.action === "restore") {
      if (!input.id || typeof input.id !== "string")
        throw new Error(
          "Restore requires an exact id returned by trash list or put.",
        );
      const item = (await this.backend.list()).find(
        (entry) => entry.id === input.id,
      );
      if (!item) throw new Error("Trash item not found; list the bin again.");
      const destination = resolvePath(
        input.destination ?? item.originalPath,
        cwd,
      );
      return locked(
        [destination],
        async () => {
          if (await exists(destination))
            throw new Error(
              "Restore destination already exists; choose a different destination.",
            );
          const { stat } = await import("node:fs/promises");
          if (!(await stat(path.dirname(destination))).isDirectory())
            throw new Error(
              "Restore parent must be an existing directory; use mkdir first.",
            );
          checkAbort(signal);
          const restored = await this.backend.restore(item.id, destination);
          return { action: "restore", backend: this.backend.name, ...restored };
        },
        signal,
      );
    }
    if (input.confirm !== "EMPTY")
      throw new Error(
        'Empty permanently destroys selected recycled items and requires confirm: "EMPTY".',
      );
    const explicitIds = Array.isArray(input.ids) && input.ids.length > 0;
    if (explicitIds === (input.all === true))
      throw new Error(
        "Empty requires either a non-empty ids array or all: true, never both.",
      );
    const snapshot = await this.backend.list();
    const ids = input.all
      ? snapshot.map((item) => item.id)
      : (input.ids as string[]);
    if (ids.length > 256)
      throw new Error(
        "Empty is limited to 256 items per call; select exact ids in smaller batches.",
      );
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !id)
    )
      throw new Error("Empty ids must be unique, non-empty strings.");
    if (ids.some((id) => !snapshot.some((item) => item.id === id)))
      throw new Error(
        "Selected item is missing or changed; no items emptied. List the bin again.",
      );
    checkAbort(signal);
    const result = ids.length
      ? await this.backend.purge(ids)
      : { removed: [], failed: [] };
    return {
      action: "empty",
      backend: this.backend.name,
      scope: input.all ? "snapshot-of-entire-bin" : "selected-ids",
      ...result,
    };
  }
}
