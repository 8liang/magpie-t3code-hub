/** Shared option parsing for the server, plugin entry and CLI helpers. */
export function optionString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function optionNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** undefined, null and a blank string all mean "the option was not set". */
export function optionPresent(value: unknown): boolean {
  return !(
    value === undefined ||
    value === null ||
    (typeof value === "string" && !value.trim())
  );
}

function describeOption(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Like optionNumber, but a value that is present and not a number is a
 * configuration error, not a reason to fall back to the default silently.
 */
export function strictOptionNumber(value: unknown, name: string): number | undefined {
  if (!optionPresent(value)) return undefined;
  const parsed = optionNumber(value);
  if (parsed === undefined) {
    throw new Error(`Invalid ${name} ${describeOption(value)}: expected a number.`);
  }
  return parsed;
}

/** Strict parsing plus the same range clamp used for timing options. */
export function strictBoundedNumber(
  value: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = strictOptionNumber(value, name);
  if (parsed === undefined) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
