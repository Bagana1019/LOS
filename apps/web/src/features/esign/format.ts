const FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ulaanbaatar',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** ISO цаг → `YYYY-MM-DD HH:mm:ss` (Asia/Ulaanbaatar, UTC+8). Буруу огноо бол оролтыг хэвээр буцаана. */
export function formatUlaanbaatar(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const p: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const { type, value } of FORMATTER.formatToParts(time)) p[type] = value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
