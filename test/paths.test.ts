import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonical,
  contains,
  pathKey,
  protect,
  resolvePath,
  validatePath,
} from "../src/paths.js";
import { fixture } from "./support.js";

test("Windows case and separator keys are identical", () => {
  assert.equal(pathKey("C:/Data/A", "win32"), pathKey("c:\\data\\a", "win32"));
});
test("reject Windows alias, reserved, ADS and device paths", () => {
  const invalid = [
    "C:relative",
    "\\root",
    "C:/x/a.",
    "C:/x/a ",
    "C:/x/nul.txt",
    "C:/x/COM1",
    "C:/x/a:b",
    "\\\\?\\C:\\x",
    "\\\\.\\NUL",
    "x\u0000y",
    "x\u0081y",
  ];
  for (const value of invalid)
    assert.throws(() => validatePath(value, "win32"));
  validatePath("C:/数据/a [1].txt", "win32");
  validatePath("\\\\server\\share\\file.txt", "win32");
});
test("normalize @ prefix and reject empty/control paths", () => {
  const cwd = process.cwd();
  assert.equal(resolvePath("@src/x", cwd), path.join(cwd, "src", "x"));
  for (const value of ["", "@", "a\nb"])
    assert.throws(() => resolvePath(value, cwd));
});
test("containment distinguishes sibling prefix", () => {
  const parent = path.resolve("parent");
  assert.equal(contains(parent, path.join(parent, "child")), true);
  assert.equal(contains(parent, `${parent}-other`), false);
});
test("canonical resolves nonexistent children through a junction", async (t) => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, "real"));
  await symlink(
    path.join(root, "real"),
    path.join(root, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(
    pathKey(await canonical(path.join(root, "alias", "new"))),
    pathKey(path.join(root, "real", "new")),
  );
});
test("protect root, home, cwd and cwd ancestor", async (t) => {
  const { root } = await fixture(t);
  const cwd = path.join(root, "work");
  await mkdir(cwd);
  for (const value of [path.parse(root).root, homedir(), cwd, root])
    await assert.rejects(protect(value, cwd), /Refusing/);
  const file = path.join(cwd, "ok");
  await writeFile(file, "ok");
  await protect(file, cwd);
});
