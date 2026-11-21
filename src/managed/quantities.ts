export type HumanNumber = number | string;
export type QuantityKind = "count" | "bytes" | "hours";

/** Bare k/m/g/t/p and byte aliases are explicitly binary, case-insensitive. */
export function parseQuantity(
  value: unknown,
  kind: QuantityKind,
  field: string,
): number {
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (kind !== "hours" && !Number.isSafeInteger(value))
    )
      throw new Error(
        `${field} must be a finite ${kind === "hours" ? "number of hours" : "safe integer"}.`,
      );
    return value;
  }
  if (typeof value !== "string" || value.length > 128)
    throw new Error(
      `${field} must be a number or a short human-readable string.`,
    );
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)\s*$/iu.exec(value);
  if (!match)
    throw new Error(`${field}: invalid quantity ${JSON.stringify(value)}.`);
  const unit = match[2].toLowerCase();
  let multiplier: bigint;
  if (kind === "hours") {
    const units: Record<string, bigint> = {
      "": 3_600_000n,
      h: 3_600_000n,
      hr: 3_600_000n,
      hours: 3_600_000n,
      d: 86_400_000n,
      days: 86_400_000n,
      w: 604_800_000n,
      weeks: 604_800_000n,
      y: 31_536_000_000n,
      years: 31_536_000_000n,
      min: 60_000n,
      s: 1_000n,
    };
    const found = units[unit];
    if (typeof found !== "bigint")
      throw new Error(
        `${field}: use hours, h/d/w/y, min or s for durations; k/m/g are count/size multipliers.`,
      );
    multiplier = found;
  } else {
    const suffix =
      kind === "bytes"
        ? /^(?:b|([kmgtp])(?:i?b)?)?$/u.exec(unit)
        : /^(?:([kmgtp])i?)?$/u.exec(unit);
    if (!suffix)
      throw new Error(
        `${field}: unsupported ${kind} suffix ${JSON.stringify(match[2])}.`,
      );
    const power = suffix[1] ? "kmgtp".indexOf(suffix[1]) + 1 : 0;
    multiplier = 1024n ** BigInt(power);
  }
  const [whole, fraction = ""] = match[1].split(".");
  const numerator = BigInt(`${whole || "0"}${fraction}`) * multiplier;
  const denominator = 10n ** BigInt(fraction.length);
  if (numerator % denominator !== 0n)
    throw new Error(
      `${field} must resolve to whole ${kind === "hours" ? "milliseconds" : kind === "bytes" ? "bytes" : "items"}; no rounding is performed.`,
    );
  const exact = numerator / denominator;
  if (exact > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${field} exceeds exact integer precision.`);
  return Number(exact) / (kind === "hours" ? 3_600_000 : 1);
}
