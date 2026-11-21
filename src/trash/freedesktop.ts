import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { moveNoReplace } from "../move.js";
import { canonical, contains, exists, hasControlCharacters } from "../paths.js";
import { errorMessage, type TrashBackend, type TrashItem } from "../types.js";

type Move = (source: string, destination: string) => Promise<void>;
export interface FreedesktopOptions {
  root?: string;
  move?: Move;
}

export function decodeTrashInfo(text: string): {
  originalPath: string;
  deletedAt: string;
} {
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (lines[0] !== "[Trash Info]")
    throw new Error("Invalid .trashinfo header.");
  const field = (name: string) => {
    const values = lines.filter((line) => line.startsWith(`${name}=`));
    if (values.length !== 1)
      throw new Error(`Invalid .trashinfo ${name} field.`);
    return values[0].slice(name.length + 1);
  };
  const originalPath = decodeURIComponent(field("Path"));
  if (!path.isAbsolute(originalPath) || hasControlCharacters(originalPath))
    throw new Error("Invalid original path in .trashinfo.");
  const deletedAt = field("DeletionDate");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(deletedAt))
    throw new Error("Invalid .trashinfo deletion date.");
  return { originalPath, deletedAt };
}

/** Freedesktop home trash. Other-device puts fail instead of copy/delete. */
export class FreedesktopTrash implements TrashBackend {
  readonly name = "freedesktop-home-trash";
  readonly root: string;
  private readonly move: Move;
  constructor(options: FreedesktopOptions = {}) {
    const data =
      process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
    if (!options.root && !path.isAbsolute(data))
      throw new Error("XDG_DATA_HOME must be absolute.");
    this.root = path.resolve(options.root ?? path.join(data, "Trash"));
    this.move = options.move ?? moveNoReplace;
  }
  private async secureDirectory(value: string): Promise<void> {
    const info = await lstat(value);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Trash directory is not a real directory: ${value}`);
    if (
      process.platform === "linux" &&
      (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    )
      throw new Error(
        `Trash directory must be owned by the current user with mode 0700: ${value}`,
      );
  }
  private async prepare(create: boolean): Promise<boolean> {
    if (!(await exists(this.root))) {
      if (!create) return false;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
    }
    await this.secureDirectory(this.root);
    for (const folder of ["info", "files"]) {
      const value = path.join(this.root, folder);
      if (!(await exists(value)) && create) await mkdir(value, { mode: 0o700 });
      await this.secureDirectory(value);
    }
    return true;
  }
  private locations(id: string) {
    if (
      !id ||
      id === "." ||
      id === ".." ||
      /[\\/]/u.test(id) ||
      hasControlCharacters(id)
    )
      throw new Error("Invalid trash item id.");
    return {
      info: path.join(this.root, "info", `${id}.trashinfo`),
      content: path.join(this.root, "files", id),
    };
  }
  private async readItem(id: string): Promise<TrashItem> {
    const locations = this.locations(id);
    const info = await lstat(locations.info);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Trash metadata is not a regular file.");
    if (process.platform === "linux" && info.uid !== process.getuid?.())
      throw new Error("Trash metadata belongs to another user.");
    const metadata = decodeTrashInfo(await readFile(locations.info, "utf8"));
    const content = await lstat(locations.content);
    return {
      id,
      ...metadata,
      name: path.basename(metadata.originalPath),
      kind: content.isSymbolicLink()
        ? "symlink"
        : content.isDirectory()
          ? "directory"
          : "file",
    };
  }
  async list(): Promise<TrashItem[]> {
    if (!(await this.prepare(false))) return [];
    const entries = await readdir(path.join(this.root, "info"));
    if (entries.length > 10000)
      throw new Error("Trash exceeds the bounded enumeration limit (10000).");
    const result: TrashItem[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".trashinfo")) continue;
      // Broken metadata is an error, never silently reclassified as an empty bin.
      result.push(await this.readItem(entry.slice(0, -10)));
    }
    return result;
  }
  async put(value: string): Promise<TrashItem> {
    await this.prepare(true);
    const source = await canonical(value);
    const trash = await canonical(this.root);
    if (contains(source, trash) || contains(trash, source))
      throw new Error(
        "Cannot trash the trash directory, an ancestor, or an item inside it.",
      );
    const sourceStat = await lstat(value);
    if (sourceStat.dev !== (await stat(path.join(this.root, "files"))).dev)
      throw new Error(
        "Source is on another device; home-trash backend refuses cross-device copy/delete. Use that filesystem's desktop trash.",
      );
    const id = `pi-file-tools-${randomUUID()}`;
    const locations = this.locations(id);
    const date = new Date();
    const deletionDate = new Date(
      date.getTime() - date.getTimezoneOffset() * 60000,
    )
      .toISOString()
      .slice(0, 19);
    const encodedPath = value
      .split(path.sep)
      .map(encodeURIComponent)
      .join(path.sep);
    await writeFile(
      locations.info,
      `[Trash Info]\nPath=${encodedPath}\nDeletionDate=${deletionDate}\n`,
      { flag: "wx", mode: 0o600 },
    );
    try {
      await this.move(value, locations.content);
    } catch (error) {
      if ((await exists(value)) && !(await exists(locations.content)))
        await unlink(locations.info);
      throw error;
    }
    return this.readItem(id);
  }
  async restore(
    id: string,
    destination?: string,
  ): Promise<{ id: string; destination: string }> {
    await this.prepare(false);
    const item = await this.readItem(id);
    const target = destination ?? item.originalPath;
    if (await exists(target))
      throw new Error(
        "Restore destination already exists; choose a different destination.",
      );
    if (!(await stat(path.dirname(target))).isDirectory())
      throw new Error("Restore parent must be an existing directory.");
    const locations = this.locations(id);
    await this.move(locations.content, target);
    try {
      await unlink(locations.info);
    } catch (error) {
      throw new Error(
        `Restored to ${target}, but metadata cleanup failed: ${errorMessage(error)}`,
      );
    }
    return { id, destination: target };
  }
  async purge(
    ids: string[],
  ): Promise<{ removed: string[]; failed: { id: string; error: string }[] }> {
    await this.prepare(false);
    for (const id of ids) await this.readItem(id);
    const removed: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      const locations = this.locations(id);
      try {
        await rm(locations.content, { recursive: true, force: false });
        await unlink(locations.info);
        removed.push(id);
      } catch (error) {
        failed.push({ id, error: errorMessage(error) });
      }
    }
    return { removed, failed };
  }
}
