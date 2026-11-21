import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  rmdir,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { moveNoReplace } from "./move.js";
import {
  canonical,
  contains,
  exists,
  locked,
  pathKey,
  protect,
  resolvePath,
} from "./paths.js";
import {
  checkAbort,
  errorMessage,
  type OperationResult,
  type TrashBackend,
  type TrashItem,
} from "./types.js";

export interface TransferInput {
  source: string;
  destination: string;
  recursive?: boolean;
  overwrite?: boolean;
}

async function copyEntry(
  source: string,
  destination: string,
  recursive: boolean,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    const target = await readlink(source);
    if (process.platform === "win32") {
      // Junctions do not require Developer Mode; file symlinks still follow OS privilege policy.
      let directory = false;
      try {
        directory = (await stat(source)).isDirectory();
      } catch {
        /* dangling file symlink */
      }
      await symlink(
        directory ? path.resolve(path.dirname(source), target) : target,
        destination,
        directory ? "junction" : "file",
      );
    } else await symlink(target, destination);
  } else if (info.isDirectory()) {
    if (!recursive)
      throw new Error("Copying a directory requires recursive: true.");
    await mkdir(destination);
    for (const entry of await readdir(source))
      await copyEntry(
        path.join(source, entry),
        path.join(destination, entry),
        true,
        signal,
      );
    if (process.platform !== "win32")
      await chmod(destination, info.mode & 0o777);
  } else if (info.isFile()) {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    if (process.platform !== "win32")
      await chmod(destination, info.mode & 0o777);
  } else throw new Error(`Unsupported special filesystem entry: ${source}`);
}

export class FileOperations {
  constructor(
    private readonly trash: TrashBackend,
    private readonly move = moveNoReplace,
  ) {}
  async mkdir(
    value: string,
    cwd: string,
    recursive = true,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    const target = resolvePath(value, cwd);
    return locked(
      [target],
      async () => {
        const present = await exists(target);
        if (present && !(await lstat(target)).isDirectory())
          throw new Error("Path exists and is not a directory.");
        checkAbort(signal);
        if (!present) await mkdir(target, { recursive });
        return { path: target, recursive, created: !present };
      },
      signal,
    );
  }
  async transfer(
    kind: "copy" | "rename",
    input: TransferInput,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<OperationResult> {
    const source = resolvePath(input.source, cwd);
    const destination = resolvePath(input.destination, cwd);
    return locked(
      [source, destination],
      async () => {
        const sourceInfo = await lstat(source);
        const sourceReal = await canonical(source);
        const destinationReal = await canonical(destination);
        if (pathKey(sourceReal) === pathKey(destinationReal))
          throw new Error("Source and destination must differ.");
        if (sourceInfo.isDirectory() && contains(sourceReal, destinationReal))
          throw new Error(
            "Cannot transfer a directory into its own descendant.",
          );
        if (contains(destinationReal, sourceReal))
          throw new Error("Cannot replace an ancestor of the source.");
        if (kind === "rename") await protect(source, cwd);
        if (!(await stat(path.dirname(destination))).isDirectory())
          throw new Error("Destination parent must exist; use mkdir first.");
        if (
          kind === "rename" &&
          sourceInfo.dev !== (await stat(path.dirname(destination))).dev
        )
          throw new Error(
            "Cross-volume rename is refused before changing the destination; use copy and then trash explicitly.",
          );
        const destinationExists = await exists(destination);
        if (destinationExists) {
          if (!input.overwrite)
            throw new Error(
              "Destination exists; set overwrite: true to replace it through the Recycle Bin.",
            );
          await protect(destination, cwd);
          if (
            (await lstat(destination)).isDirectory() !==
            sourceInfo.isDirectory()
          )
            throw new Error(
              "Refusing to replace entries of different directory kinds.",
            );
        }
        if (kind === "copy" && sourceInfo.isDirectory() && !input.recursive)
          throw new Error("Copying a directory requires recursive: true.");
        let staging: string | undefined;
        let saved: TrashItem | undefined;
        let committed = false;
        try {
          let prepared = source;
          if (kind === "copy") {
            staging = await mkdtemp(
              path.join(path.dirname(destination), ".pi-file-tools-stage-"),
            );
            prepared = path.join(staging, "payload");
            await copyEntry(source, prepared, !!input.recursive, signal);
          }
          checkAbort(signal);
          if (destinationExists) saved = await this.trash.put(destination);
          checkAbort(signal);
          await this.move(prepared, destination);
          committed = true;
        } catch (error) {
          if (saved && !committed) {
            try {
              await this.trash.restore(saved.id, destination);
            } catch (rollback) {
              throw new Error(
                `${errorMessage(error)}; old destination remains recoverable as trash id ${saved.id}; rollback failed: ${errorMessage(rollback)}`,
                { cause: error },
              );
            }
          }
          throw error;
        } finally {
          if (staging) {
            // Only plugin-created staging content is removed permanently; user overwrites go to the OS bin.
            if (committed) await rmdir(staging);
            else await rm(staging, { recursive: true, force: false });
          }
        }
        return {
          source,
          destination,
          recursive: input.recursive ?? false,
          overwrite: input.overwrite ?? false,
          ...(saved ? { replacedItem: saved } : {}),
        };
      },
      signal,
    );
  }
}
