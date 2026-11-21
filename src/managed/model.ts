import { MANAGED_LIMITS } from "./limits.js";
import { type HumanNumber, parseQuantity } from "./quantities.js";

export type Category = "backup" | "temp";
export interface Policy {
  ttlHours: number;
  maxItems: number;
  maxBytes: number;
  purgeAfterHours: number;
  maxRecycledBytes: number;
}
export type PolicyInput = Partial<Record<keyof Policy, HumanNumber>>;
export function normalizePolicyPatch(
  value: unknown,
  field = "policy",
): Partial<Policy> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${field} must be an object.`);
  const result: Partial<Policy> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (
      ![
        "ttlHours",
        "maxItems",
        "maxBytes",
        "purgeAfterHours",
        "maxRecycledBytes",
      ].includes(key)
    )
      throw new Error(`${field}: unknown policy field ${key}.`);
    const kind =
      key === "maxItems"
        ? "count"
        : key === "ttlHours" || key === "purgeAfterHours"
          ? "hours"
          : "bytes";
    result[key as keyof Policy] = parseQuantity(raw, kind, `${field}.${key}`);
  }
  return result;
}
export interface Item {
  id: string;
  category: Category;
  name: string;
  path: string;
  kind: "file" | "directory";
  originalPath?: string;
  project: string;
  purpose: string;
  owner: string;
  createdAt: number;
  expiresAt: number;
  leaseUntil: number;
  pinned: boolean;
  bytes: number;
  digest?: string;
  state:
    | "creating"
    | "active"
    | "recycling"
    | "recycled"
    | "purging"
    | "purged"
    | "failed";
  trashId?: string;
  recycledAt?: number;
  error?: string;
}
export interface StoreState {
  version: 1;
  policies: Record<Category, Policy>;
  items: Item[];
  lastSweep: number;
}
export const DEFAULT_POLICIES: Record<Category, Policy> = {
  backup: {
    ttlHours: 720,
    maxItems: 50,
    maxBytes: 5 * 1024 ** 3,
    purgeAfterHours: 168,
    maxRecycledBytes: 1024 ** 3,
  },
  temp: {
    ttlHours: 24,
    maxItems: 100,
    maxBytes: 2 * 1024 ** 3,
    purgeAfterHours: 168,
    maxRecycledBytes: 1024 ** 3,
  },
};
export const LEASE_MS = 15 * 60 * 1000;
export function validatePolicy(p: Policy): void {
  if (
    !p ||
    Object.keys(p).sort().join() !==
      [
        "ttlHours",
        "maxItems",
        "maxBytes",
        "purgeAfterHours",
        "maxRecycledBytes",
      ]
        .sort()
        .join()
  )
    throw new Error("Invalid policy fields.");
  for (const key of ["ttlHours", "purgeAfterHours"] as const)
    if (
      !Number.isFinite(p[key]) ||
      p[key] < 1 ||
      p[key] > MANAGED_LIMITS.maxHours
    )
      throw new Error(`${key} must be 1..${MANAGED_LIMITS.maxHours} hours.`);
  if (
    !Number.isSafeInteger(p.maxItems) ||
    p.maxItems < 1 ||
    p.maxItems > MANAGED_LIMITS.maxItems
  )
    throw new Error(
      `maxItems must be a positive integer <= ${MANAGED_LIMITS.maxItems} (64K).`,
    );
  for (const key of ["maxBytes", "maxRecycledBytes"] as const)
    if (
      !Number.isSafeInteger(p[key]) ||
      p[key] < 1 ||
      p[key] > MANAGED_LIMITS.maxBytes
    )
      throw new Error(
        `${key} must be a positive integer <= ${MANAGED_LIMITS.maxBytes} bytes (1 PiB).`,
      );
}
export interface Plan {
  recycle: { id: string; reason: string; bytes: number }[];
  purge: { id: string; bytes: number }[];
  activeBytes: number;
  recycledBytes: number;
  overBudget: boolean;
  blocked: string[];
}
function sumBytes(items: Item[]): number {
  const total = items.reduce((sum, item) => sum + BigInt(item.bytes), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(
      "Aggregate byte count exceeds exact integer precision; no cleanup planned.",
    );
  return Number(total);
}
export function planCleanup(
  state: StoreState,
  category: Category,
  now: number,
): Plan {
  const policy = state.policies[category];
  const items = state.items.filter((i) => i.category === category);
  const active = items
    .filter((i) => i.state === "active")
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  let activeBytes = sumBytes(active);
  let count = active.length;
  const recycle: Plan["recycle"] = [];
  const blocked: string[] = [];
  for (const item of active) {
    if (item.pinned || item.leaseUntil > now) {
      blocked.push(item.id);
      continue;
    }
    const expired = item.expiresAt <= now;
    const overflow = count > policy.maxItems || activeBytes > policy.maxBytes;
    if (expired || overflow) {
      recycle.push({
        id: item.id,
        reason: expired ? "expired" : "quota",
        bytes: item.bytes,
      });
      count--;
      activeBytes -= item.bytes;
    }
  }
  const recycled = items
    .filter((i) => i.state === "recycled")
    .sort(
      (a, b) =>
        (a.recycledAt ?? 0) - (b.recycledAt ?? 0) || a.id.localeCompare(b.id),
    );
  let recycledBytes = sumBytes(recycled);
  const purge: Plan["purge"] = [];
  for (const item of recycled) {
    // A quota never shortens the minimum OS-bin recovery window.
    if (
      !item.pinned &&
      item.recycledAt !== undefined &&
      now - item.recycledAt >= policy.purgeAfterHours * 3600000
    ) {
      purge.push({ id: item.id, bytes: item.bytes });
      recycledBytes -= item.bytes;
    }
  }
  return {
    recycle,
    purge,
    activeBytes,
    recycledBytes,
    blocked,
    overBudget:
      activeBytes > policy.maxBytes ||
      count > policy.maxItems ||
      recycledBytes > policy.maxRecycledBytes,
  };
}
