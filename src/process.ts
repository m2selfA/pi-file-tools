import { spawn } from "node:child_process";

export interface ProcessOptions {
  input?: string;
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Fixed executable plus argv; user paths never become executable source. */
export function runProcess(
  executable: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error(
        `Helper timed out after ${options.timeoutMs ?? 120000}ms; mutation outcome may be uncertain. Read back state before retrying.`,
      );
      child.kill();
    }, options.timeoutMs ?? 120000);
    const capture = (chunks: Buffer[]) => (data: Buffer) => {
      bytes += data.length;
      if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) {
        failure ??= new Error(
          "Helper output exceeded its limit; read back state before retrying.",
        );
        child.kill();
      } else chunks.push(data);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") failure ??= error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      const output = Buffer.concat(stdout)
        .toString("utf8")
        .replace(/^\uFEFF/, "");
      if (code !== 0)
        return reject(
          new Error(
            `Helper exited with code ${code}: ${Buffer.concat(stderr).toString("utf8").trim() || output.trim()}`,
          ),
        );
      resolve(output);
    });
    child.stdin.end(options.input ?? "", "utf8");
  });
}
