import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { exists } from "../src/paths.js";
import { FreedesktopTrash } from "../src/trash/freedesktop.js";

export async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-file-tools-unit-"));
  t.after(() => rm(root, { recursive: true, force: false }));
  const move = async (source: string, destination: string) => {
    if (await exists(destination)) throw new Error("Destination exists.");
    await rename(source, destination);
  };
  const backend = new FreedesktopTrash({ root: path.join(root, "bin"), move });
  return { root, backend, move };
}
