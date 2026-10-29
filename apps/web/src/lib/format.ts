import { t } from './i18n';
// Формат хөрвүүлэлт ЗӨВХӨН харуулалтад (CLAUDE.md: UI-д санхүүгийн тооцоолол хийхгүй). Цагийн бүс: Asia/Ulaanbaatar (UTC+8, DST байхгүй).

export const MN_TIME_ZONE = 'Asia/Ulaanbaatar';
export const MN_UTC_OFFSET = '+08:00';
export const MNT_SIGN = '₮';
export const EMPTY_VALUE = '—';

const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const decimalFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** 1234567 → '1,234,567'. */
export function formatNumber(v: number | null | undefined): string {
  return isNum(v) ? intFormat.format(v) : EMPTY_VALUE;
}

/** 1234567 → '1,234,567₮'; бутархай хэсэгтэй бол 2 орон. */
export function formatMnt(v: number | null | undefined): string {
  if (!isNum(v)) return EMPTY_VALUE;
  return `${Number.isInteger(v) ? intFormat.format(v) : decimalFormat.format(v)}${MNT_SIGN}`;
}

/** Графикийн тэнхлэгт: 1_500_000 → '1.5 сая', 250_000 → '250 мянга'. */
export function formatMntCompact(v: number | null | undefined): string {
  if (!isNum(v)) return EMPTY_VALUE;
  const abs = Math.abs(v);
  const trim = (n: number) => String(Math.round(n * 10) / 10);
  if (abs >= 1e9) return `${trim(v / 1e9)} ${t('format.billion')}`;
  if (abs >= 1e6) return `${trim(v / 1e6)} ${t('format.million')}`;
  if (abs >= 1e3) return `${trim(v / 1e3)} ${t('format.thousand')}`;
  return String(Math.round(v));
}

/** Бутархай хувь → текст: 0.2399 → '23.99%', 0.55 → '55%'. */
export function formatPercent(ratio: number | null | undefined, maxDigits = 2): string {
  if (!isNum(ratio)) return EMPTY_VALUE;
  const fixed = (ratio * 100).toFixed(maxDigits);
  return `${fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed}%`;
}

/** Хэрэглэгчийн оруулсан хувь (2.5) ↔ API-ийн бутархай (0.025). Оролтын нэгж хөрвүүлэлт, тооцоолол биш. */
export const percentToRate = (percent: number): number => Math.round(percent * 100) / 10000;
export const rateToPercent = (rate: number): number => Math.round(rate * 10000) / 100;

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: MN_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

interface MnParts { y: string; mo: string; d: string; h: string; mi: string; s: string }
function mnParts(date: Date): MnParts {
  const out: Record<string, string> = {};
  for (const p of dateTimeFormat.formatToParts(date)) out[p.type] = p.value;
  return { y: out.year ?? '', mo: out.month ?? '', d: out.day ?? '', h: out.hour ?? '', mi: out.minute ?? '', s: out.second ?? '' };
}
const toDate = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** ISO → '2026-10-28 16:05' (Улаанбаатарын цаг). */
export function formatDateTime(iso: string | null | undefined): string {
  const d = toDate(iso);
  if (!d) return EMPTY_VALUE;
  const p = mnParts(d);
  return `${p.y}-${p.mo}-${p.d} ${p.h}:${p.mi}`;
}
export function formatDate(iso: string | null | undefined): string {
  const d = toDate(iso);
  if (!d) return EMPTY_VALUE;
  const p = mnParts(d);
  return `${p.y}-${p.mo}-${p.d}`;
}
export function formatTime(iso: string | null | undefined): string {
  const d = toDate(iso);
  if (!d) return EMPTY_VALUE;
  const p = mnParts(d);
  return `${p.h}:${p.mi}`;
}

/** Улаанбаатарын огноо 'YYYY-MM-DD'. */
export function mnDateKey(date: Date): string {
  const p = mnParts(date);
  return `${p.y}-${p.mo}-${p.d}`;
}

/** `daysBack` өдрийн өмнөх Улаанбаатарын өдрийн эхлэл (ISO, +08:00). daysBack=0 → өнөөдрийн 00:00. */
export function mnStartOfDayIso(now: Date, daysBack = 0): string {
  return `${mnDateKey(new Date(now.getTime() - daysBack * 86_400_000))}T00:00:00${MN_UTC_OFFSET}`;
}

/** <input type="date"> утга ('YYYY-MM-DD') → ISO (өдрийн эхлэл/төгсгөл, +08:00). */
export function dateInputToIso(date: string, edge: 'start' | 'end'): string {
  return edge === 'start' ? `${date}T00:00:00${MN_UTC_OFFSET}` : `${date}T23:59:59.999${MN_UTC_OFFSET}`;
}
/** ISO → <input type="date"> утга (Улаанбаатарын огноо). */
export function isoToDateInput(iso: string | null | undefined): string {
  const d = toDate(iso);
  return d ? mnDateKey(d) : '';
}

/** 45 → '45 сек', 75 → '1 мин 15 сек', 3720 → '1 цаг 2 мин'. */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (!isNum(totalSeconds)) return EMPTY_VALUE;
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} ${t('format.sec')}`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${m} ${t('format.min')} ${rest} ${t('format.sec')}` : `${m} ${t('format.min')}`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h} ${t('format.hour')} ${m} ${t('format.min')}` : `${h} ${t('format.hour')}`;
}

/** Тоолуур: 125 → '02:05'. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
