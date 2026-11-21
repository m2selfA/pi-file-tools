import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { checkAbort } from "./types.js";

export function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

export function pathKey(value: string, platform = process.platform): string {
  return platform === "win32"
    ? value.replaceAll("/", "\\").toLowerCase()
    : value;
}
export function validatePath(
  value: unknown,
  platform = process.platform,
): asserts value is string {
  if (typeof value !== "string" || !value || hasControlCharacters(value))
    throw new Error(
      "Path must be non-empty and contain no control characters.",
    );
  if (platform !== "win32") return;
  const p = value.replaceAll("/", "\\");
  if (/^\\\\[?.]\\/u.test(p) || /^[a-z]:(?!\\)/iu.test(p))
    throw new Error(
      "Windows device paths and drive-relative paths are not supported.",
    );
  if (/^\\(?!\\)/u.test(p))
    throw new Error(
      "Use an absolute drive path instead of a drive-root-relative path.",
    );
  const tail = p.replace(/^[a-z]:/iu, "");
  if (tail.includes(":"))
    throw new Error("Windows alternate data streams are not supported.");
  for (const component of tail.split("\\").filter(Boolean)) {
    if (component === "." || component === "..") continue;
    if (
      /[. ]$/u.test(component) ||
      /[<>"|?*]/u.test(component) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(component)
    )
      throw new Error(`Unsupported Windows path component: ${component}`);
  }
}
export function resolvePath(value: unknown, cwd: string): string {
  const normalized =
    typeof value === "string" && value.startsWith("@") ? value.slice(1) : value;
  validatePath(normalized);
  return path.resolve(cwd, normalized);
}
export async function exists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return false;
    throw error;
  }
}
export async function canonical(value: string): Promise<string> {
  const suffix: string[] = [];
  let current = path.resolve(value);
  for (;;) {
    try {
      return path.resolve(await realpath(current), ...suffix.reverse());
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}
export function contains(parent: string, child: string): boolean {
  const rel = path.relative(
    pathKey(path.resolve(parent)),
    pathKey(path.resolve(child)),
  );
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}
export async function protect(value: string, cwd: string): Promise<void> {
  if (pathKey(value) === pathKey(path.parse(value).root))
    throw new Error("Refusing to mutate a filesystem root.");
  if ((await lstat(value)).isSymbolicLink()) return;
  const target = await canonical(value);
  for (const [boundary, name] of [
    [cwd, "working directory"],
    [homedir(), "home directory"],
  ]) {
    if (contains(target, await canonical(boundary)))
      throw new Error(
        `Refusing to mutate the ${name} or an ancestor: ${value}`,
      );
  }
}
function ancestors(value: string): string[] {
  const result: string[] = [];
  for (let current = value; ; current = path.dirname(current)) {
    result.push(current);
    if (path.dirname(current) === current) return result;
  }
}
/** Parent locks coordinate directory mutations with other Pi file tools. */
export async function locked<T>(
  values: string[],
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  checkAbort(signal);
  const expected = await Promise.all(values.map(canonical));
  const raw = [
    ...new Set(
      values.flatMap((v, i) => [...ancestors(v), ...ancestors(expected[i])]),
    ),
  ];
  const keys = [
    ...new Set(
      await Promise.all(raw.map(async (v) => pathKey(await canonical(v)))),
    ),
  ].sort();
  async function acquire(index: number, held: Set<string>): Promise<T> {
    checkAbort(signal);
    if (index === keys.length) {
      for (let i = 0; i < values.length; i++)
        if (pathKey(await canonical(values[i])) !== pathKey(expected[i]))
          throw new Error(
            `Path changed while waiting for mutation locks: ${values[i]}`,
          );
      return fn();
    }
    const key = pathKey(await canonical(keys[index]));
    if (held.has(key))
      throw new Error("Mutation lock paths converged; refusing to deadlock.");
    return withFileMutationQueue(keys[index], () =>
      acquire(index + 1, new Set([...held, key])),
    );
  }
  return acquire(0, new Set());
}
