// dim_date.date_key (YYYYMMDD) of the Mongolian business day. Mongolia has no DST since 2017 → fixed UTC+8 (same rule as @los/calc aging).
const UB_OFFSET_MS = 8 * 3_600_000;
// packages/database/dwh/init/01-star-schema.sql seeds dim_date for 2020-01-01 … 2040-12-31; outside it the FK would reject the row.
const MIN_KEY = 20200101;
const MAX_KEY = 20401231;

/** Date key for an ISO instant, or `null` when unparseable or outside the seeded dim_date range (never throws). */
export function dateKeyOf(iso: string): number | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + UB_OFFSET_MS);
  const key = d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  return key >= MIN_KEY && key <= MAX_KEY ? key : null;
}
