/** Coerces an unknown input to a trimmed string, capped at max characters. Never throws. */
export function str(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

export function optStr(v: unknown, max: number): string | null {
  const s = str(v, max);
  return s === "" ? null : s;
}

export function int(v: unknown): number | null {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return /^\d{1,9}$/.test(s) ? Number(s) : null;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname && !/\s/.test(v);
  } catch {
    return false;
  }
}

export const PRECISIONS = ["day", "month", "year", "unknown"] as const;
export type Prec = (typeof PRECISIONS)[number];

/**
 * Parses a date entered with explicit precision. Accepts YYYY, YYYY-MM or YYYY-MM-DD and
 * returns the normalised (date, precision) pair, or an error. Never adds precision.
 */
export function parseDated(input: unknown): { date: string | null; precision: Prec } | { error: string } {
  const s = str(input, 10);
  if (s === "") return { date: null, precision: "unknown" };
  const y = s.match(/^(\d{4})$/);
  if (y) return { date: `${y[1]}-01-01`, precision: "year" };
  const ym = s.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (ym) return { date: `${ym[1]}-${ym[2]}-01`, precision: "month" };
  if (/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s)) {
    const d = new Date(`${s}T00:00:00Z`);
    if (d.toISOString().slice(0, 10) !== s) return { error: `${s} is not a real calendar date.` };
    return { date: s, precision: "day" };
  }
  return { error: `Enter dates as YYYY, YYYY-MM or YYYY-MM-DD, at the precision the source gives (got "${s}").` };
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
