// Date/time helpers (pure). Texts come from mn.maker-checker.json; no Date.now() inside - callers pass `now`.
import { mn } from '@los/ui';
import { fmt } from './labels';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A PENDING request is shown as urgent when fewer than this is left before it expires. */
export const URGENT_MS = 4 * HOUR;

export const msUntil = (iso: string, now: number): number => Date.parse(iso) - now;

/** Red "expiring soon" state: only PENDING requests, less than 4 hours left or already past. */
export function isUrgent(status: string, expiresAt: string, now: number): boolean {
  return status === 'PENDING' && msUntil(expiresAt, now) < URGENT_MS;
}

/** "3 өдөр 4 ц үлдсэн" / "2 ц 15 мин үлдсэн" / "9 мин үлдсэн" / "Хугацаа хэтэрсэн". */
export function formatRemaining(ms: number): string {
  if (!(ms > 0)) return mn['maker_checker.expires.past'];
  if (ms >= DAY) return fmt(mn['maker_checker.expires.left_dh'], { d: Math.floor(ms / DAY), h: Math.floor((ms % DAY) / HOUR) });
  if (ms >= HOUR) return fmt(mn['maker_checker.expires.left_hm'], { h: Math.floor(ms / HOUR), m: Math.floor((ms % HOUR) / MINUTE) });
  return fmt(mn['maker_checker.expires.left_m'], { m: Math.max(1, Math.ceil(ms / MINUTE)) });
}

const UB_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Ulaanbaatar',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "2026-10-28 14:05" in Ulaanbaatar time, stable on server and client. Returns the input if it is not a date. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const p: Record<string, string> = {};
  for (const part of UB_FORMAT.formatToParts(t)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
