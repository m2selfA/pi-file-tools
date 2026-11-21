import { lstat, stat } from "node:fs/promises";
import path from "node:path";
import { exists } from "./paths.js";
import { runProcess } from "./process.js";
import { windowsRequest } from "./trash/windows.js";

/** OS no-clobber moves: neither existing files nor directories are overwritten. */
export async function moveNoReplace(
  source: string,
  destination: string,
): Promise<void> {
  if ((await lstat(source)).dev !== (await stat(path.dirname(destination))).dev)
    throw new Error(
      "Cross-volume moves are refused; use copy and then trash explicitly.",
    );
  if (process.platform === "win32") {
    await windowsRequest({ action: "moveNoReplace", source, destination });
    return;
  }
  if (process.platform !== "linux")
    throw new Error("Supported platforms: Windows and Linux.");
  await runProcess("/usr/bin/mv", [
    "--no-clobber",
    "--no-target-directory",
    "--",
    source,
    destination,
  ]);
  // GNU mv -n can return zero after skipping a collision.
  if (await exists(source))
    throw new Error(
      "No-clobber move was skipped; the source remains in place.",
    );
  if (!(await exists(destination)))
    throw new Error(
      "Move outcome could not be verified; inspect both paths before retrying.",
    );
}
