import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "../src/process.js";

test("helper transports Unicode JSON through stdin without shell evaluation", async () => {
  const input = JSON.stringify({ path: "中文 & ' $() ; [1].txt" });
  const output = await runProcess(
    process.execPath,
    ["-e", "process.stdin.pipe(process.stdout)"],
    { input },
  );
  assert.equal(output, input);
});
test("helper propagates nonzero exit and stderr", async () => {
  await assert.rejects(
    runProcess(process.execPath, [
      "-e",
      "process.stderr.write('test-failure');process.exit(7)",
    ]),
    /code 7: test-failure/,
  );
});
test("helper enforces output bound", async () => {
  await assert.rejects(
    runProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(10000))"],
      { maxBytes: 10 },
    ),
    /exceeded/,
  );
});
test("helper timeout reports uncertain outcome instead of success", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 100,
    }),
    /timed out.*uncertain/,
  );
});
