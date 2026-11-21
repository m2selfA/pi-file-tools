/** Validation bounds, not promises of throughput or available disk space. */
export const MANAGED_LIMITS = {
  maxItems: 65_536,
  maxBytes: 1024 ** 5,
  maxHours: 100 * 365 * 24,
  registryItems: 262_144,
  registryBytes: 256 * 1024 ** 2,
  treeEntries: 100_000,
} as const;

/** Refuse oversized metadata before replacing an otherwise readable registry. */
export function encodeRegistry(
  value: unknown,
  maxBytes: number = MANAGED_LIMITS.registryBytes,
): string {
  const serialized = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes)
    throw new Error(
      `Registry exceeds ${maxBytes} bytes; previous state was preserved.`,
    );
  return serialized;
}
