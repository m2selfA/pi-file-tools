export interface TrashItem {
  id: string;
  originalPath: string;
  name: string;
  deletedAt: string;
  kind: "file" | "directory" | "symlink";
}

export interface TrashBackend {
  readonly name: string;
  put(path: string): Promise<TrashItem>;
  list(): Promise<TrashItem[]>;
  restore(
    id: string,
    destination?: string,
  ): Promise<{ id: string; destination: string }>;
  purge(
    ids: string[],
  ): Promise<{ removed: string[]; failed: { id: string; error: string }[] }>;
}

export interface OperationResult {
  [key: string]: unknown;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new Error("Operation aborted before the next mutation.");
}
