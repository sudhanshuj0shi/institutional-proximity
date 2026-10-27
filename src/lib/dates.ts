export type Precision = "day" | "month" | "year" | "unknown";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

/** Formats a date at exactly the precision the source supports. Never adds precision. */
export function formatDated(date: string | null | undefined, precision: Precision | null | undefined): string {
  if (!date || !precision || precision === "unknown") return "Date not established";
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  if (precision === "year") return String(y);
  if (precision === "month") return `${MONTHS[m - 1]} ${y}`;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function formatRange(
  from: string | null, fromP: Precision, until: string | null, untilP: Precision, ongoingAsOf?: string | null,
): string {
  const noStart = !(from && fromP !== "unknown");
  const noEnd = !(until && untilP !== "unknown") && !ongoingAsOf;
  if (noStart && noEnd) return "Dates not established";
  const a = noStart ? "Start date not established" : formatDated(from, fromP);
  let b: string;
  if (until && untilP !== "unknown") b = formatDated(until, untilP);
  else if (ongoingAsOf) b = `still in office as of ${formatDated(ongoingAsOf, "day")}`;
  else b = "end date not established";
  return `${a} – ${b}`;
}

/** Sort key that keeps unknown dates last instead of inventing an order. */
export function sortKey(date: string | null | undefined): string {
  return date ?? "9999-12-31";
}

export function formatTimestamp(ts: Date | string | null | undefined): string {
  if (!ts) return "Not recorded";
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function isoDay(ts: Date | string): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  return d.toISOString().slice(0, 10);
}
