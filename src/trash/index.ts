import type { TrashBackend } from "../types.js";
import { FreedesktopTrash } from "./freedesktop.js";
import { WindowsTrash } from "./windows.js";

export function createTrashBackend(): TrashBackend {
  if (process.platform === "win32") return new WindowsTrash();
  if (process.platform === "linux") return new FreedesktopTrash();
  throw new Error(
    "pi-file-tools supports Windows and Linux; this platform has no configured trash backend.",
  );
}
