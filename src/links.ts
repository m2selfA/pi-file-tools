import { windowsRequest } from "./trash/windows.js";
export type WindowsLinkKind = "file" | "dir" | "junction";
/** Read-only, non-dereferencing metadata; batched to keep the helper protocol bounded. */
export async function windowsLinkKinds(
  paths: string[],
): Promise<Map<string, WindowsLinkKind>> {
  const result = new Map<string, WindowsLinkKind>();
  for (let offset = 0; offset < paths.length; offset += 128) {
    const batch = paths.slice(offset, offset + 128);
    const reply = await windowsRequest<{
      items: { path: string; kind: WindowsLinkKind }[];
    }>({ action: "linkKinds", paths: batch });
    if (!Array.isArray(reply.items) || reply.items.length !== batch.length)
      throw new Error("Incomplete link metadata; no copy performed.");
    for (const row of reply.items) {
      if (
        !batch.includes(row.path) ||
        result.has(row.path) ||
        !["file", "dir", "junction"].includes(row.kind)
      )
        throw new Error("Invalid link metadata; no copy performed.");
      result.set(row.path, row.kind);
    }
  }
  return result;
}
