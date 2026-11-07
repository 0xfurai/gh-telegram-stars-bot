// The README's coverage badge, as a shields.io endpoint file
// (https://shields.io/badges/endpoint-badge). Pure: no I/O.

export interface EndpointBadge {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
}

/** The colour for a percentage: the first threshold it reaches. */
const COLORS: readonly (readonly [minimum: number, color: string])[] = [
  [90, "brightgreen"],
  [80, "green"],
  [70, "yellowgreen"],
  [60, "yellow"],
  [0, "red"],
];

/** The badge for a line coverage percentage (0-100). */
export function coverageBadge(percent: number): EndpointBadge {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`Coverage must be 0-100, got ${percent}`);
  }
  const color = COLORS.find(([minimum]) => percent >= minimum)?.[1] ?? "red";
  return { schemaVersion: 1, label: "coverage", message: `${percent.toFixed(1)}%`, color };
}
