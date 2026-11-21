import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { checkAbort } from "../types.js";
import { MANAGED_LIMITS } from "./limits.js";

interface Entry {
  name: string;
  kind: "file" | "directory";
  size: number;
  hash?: string;
  mode: number;
}
export interface Tree {
  kind: "file" | "directory";
  bytes: number;
  digest: string;
  entries: Entry[];
}
/** Never follow symlinks/junctions. Bounded scans stream file contents. */
export async function inspectTree(
  root: string,
  maxBytes: number = MANAGED_LIMITS.maxBytes,
  signal?: AbortSignal,
): Promise<Tree> {
  const entries: Entry[] = [];
  let bytes = 0;
  async function visit(value: string, name: string): Promise<void> {
    checkAbort(signal);
    if (entries.length >= MANAGED_LIMITS.treeEntries)
      throw new Error(
        `Tree exceeds ${MANAGED_LIMITS.treeEntries} entries; no partial snapshot accepted.`,
      );
    const info = await lstat(value);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      throw new Error(
        `Links/junctions and special entries are refused: ${value}`,
      );
    if (info.isDirectory()) {
      entries.push({
        name,
        kind: "directory",
        size: 0,
        mode: info.mode & 0o777,
      });
      for (const child of (await readdir(value)).sort())
        await visit(path.join(value, child), name ? `${name}/${child}` : child);
    } else {
      bytes += info.size;
      if (bytes > maxBytes) throw new Error("Tree exceeds the byte budget.");
      const file = await open(
        value,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const hash = createHash("sha256");
      try {
        const before = await file.stat();
        if (
          before.ino !== info.ino ||
          before.dev !== info.dev ||
          !before.isFile()
        )
          throw new Error("File changed while opening snapshot.");
        const buffer = Buffer.alloc(256 * 1024);
        let length = 0;
        for (;;) {
          checkAbort(signal);
          const part = await file.read(buffer, 0, buffer.length, null);
          if (!part.bytesRead) break;
          length += part.bytesRead;
          if (length > info.size)
            throw new Error("File grew while snapshotting.");
          hash.update(buffer.subarray(0, part.bytesRead));
        }
        const after = await file.stat();
        const current = await lstat(value);
        if (
          length !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs ||
          current.ino !== info.ino ||
          current.isSymbolicLink()
        )
          throw new Error(
            "File changed during snapshot; retry after writers stop.",
          );
      } finally {
        await file.close();
      }
      entries.push({
        name,
        kind: "file",
        size: info.size,
        hash: hash.digest("hex"),
        mode: info.mode & 0o777,
      });
    }
  }
  await visit(root, "");
  // Permissions are metadata, not part of byte-level restoration equivalence on Windows.
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        entries.map(({ name, kind, size, hash }) => ({
          name,
          kind,
          size,
          hash,
        })),
      ),
    )
    .digest("hex");
  return { kind: entries[0].kind, bytes, digest, entries };
}
export async function copyTree(
  source: string,
  destination: string,
  tree: Tree,
  signal?: AbortSignal,
): Promise<void> {
  if (tree.kind === "directory") await mkdir(destination, { mode: 0o700 });
  for (const entry of tree.entries) {
    checkAbort(signal);
    const from = entry.name
      ? path.join(source, ...entry.name.split("/"))
      : source;
    const to = entry.name
      ? path.join(destination, ...entry.name.split("/"))
      : destination;
    const info = await lstat(from);
    if (info.isSymbolicLink())
      throw new Error("Source redirected while copying.");
    if (entry.kind === "directory") {
      if (entry.name) await mkdir(to, { mode: 0o700 });
    } else await copyFile(from, to, constants.COPYFILE_EXCL);
  }
  if (process.platform !== "win32")
    for (const entry of [...tree.entries].reverse())
      await chmod(
        entry.name
          ? path.join(destination, ...entry.name.split("/"))
          : destination,
        entry.mode,
      );
}
/** Reject a redirected store path, including every existing parent. */
export async function noLinks(value: string): Promise<void> {
  for (let current = path.resolve(value); ; current = path.dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Refusing redirected storage path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (path.dirname(current) === current) break;
  }
}
