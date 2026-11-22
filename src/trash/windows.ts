import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatLockDiagnostics, withFileLock } from "../managed/locks.js";
import { runProcess } from "../process.js";
import type { TrashBackend, TrashItem } from "../types.js";

export async function windowsRequest<T>(request: object): Promise<T> {
  if (process.platform !== "win32")
    throw new Error("Windows Shell backend requires Windows.");
  const executable = path.join(
    process.env.SystemRoot ?? "C:/Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  if (!existsSync(executable))
    throw new Error(
      "Windows PowerShell 5.1 is required for the native Recycle Bin backend.",
    );
  const script = fileURLToPath(
    new URL("../native/recycle.ps1", import.meta.url),
  );
  const output = await runProcess(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-File", script],
    { input: JSON.stringify(request), cwd: path.dirname(script) },
  );
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(
      "Invalid native-helper response; inspect state before retrying a mutation.",
    );
  }
}

export interface WindowsTrashOptions {
  lockPath?: string | false;
  lockWaitMs?: number;
}

export class WindowsTrash implements TrashBackend {
  readonly name = "windows-shell-recycle-bin";
  private readonly lockPath: string | undefined;
  private readonly lockWaitMs: number;
  constructor(options: WindowsTrashOptions = {}) {
    this.lockPath =
      options.lockPath === false
        ? undefined
        : (options.lockPath ??
          path.join(tmpdir(), "pi-file-tools-windows-trash.lock"));
    this.lockWaitMs = options.lockWaitMs ?? 30_000;
  }
  private async serialized<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.lockPath) return fn();
    return withFileLock(
      {
        lockPath: this.lockPath,
        operation: `windows-trash:${operation}`,
        waitMs: this.lockWaitMs,
        staleGraceMs: 15_000,
        autoReclaimStale: true,
        busyMessage: (lockPath, owner) =>
          `Windows Recycle Bin helper is busy: ${formatLockDiagnostics(lockPath, owner)}`,
      },
      fn,
    );
  }
  async list(): Promise<TrashItem[]> {
    return this.serialized("list", async () => {
      return (await windowsRequest<{ items: TrashItem[] }>({ action: "list" }))
        .items;
    });
  }
  async put(value: string): Promise<TrashItem> {
    if (!/^[a-z]:\\/iu.test(value))
      throw new Error(
        "Recycle Bin put requires a local absolute drive path; UNC/network paths are refused.",
      );
    return this.serialized("put", async () => {
      const stat = await lstat(value);
      const result = await windowsRequest<{ item: TrashItem }>({
        action: "put",
        path: value,
      });
      return {
        ...result.item,
        kind: stat.isSymbolicLink()
          ? "symlink"
          : stat.isDirectory()
            ? "directory"
            : "file",
      };
    });
  }
  async restore(
    id: string,
    destination?: string,
  ): Promise<{ id: string; destination: string }> {
    return this.serialized("restore", () =>
      windowsRequest({ action: "restore", id, destination }),
    );
  }
  async purge(
    ids: string[],
  ): Promise<{ removed: string[]; failed: { id: string; error: string }[] }> {
    return this.serialized("purge", () =>
      windowsRequest({ action: "purge", ids }),
    );
  }
}
