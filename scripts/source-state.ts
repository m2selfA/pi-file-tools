import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export async function sourceState(root: string) {
  const names = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "biome.json",
    "file-tools.example.json",
    ".gitattributes",
  ];
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) names.push(name);
    }
  }
  for (const directory of ["src", "test", "scripts"]) await walk(directory);
  const files = [];
  for (const name of names.sort()) {
    const data = await readFile(path.join(root, name));
    files.push({
      path: name,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  return {
    inputDigest: createHash("sha256")
      .update(JSON.stringify(files))
      .digest("hex"),
    files,
  };
}
