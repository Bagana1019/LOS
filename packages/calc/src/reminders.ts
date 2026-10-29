// Төлөлт сануулах хуваарь (FR-13.2): төлөх өдрөөс X хоногийн өмнө / өдөр нь / Y хоног хэтэрсэн. Босго нь setting-ээс (BR hardcode хийхгүй).
import { diffDays } from './aging';

export type ReminderKind = 'UPCOMING' | 'DUE_TODAY' | 'OVERDUE';
export interface ReminderPolicy { beforeDueDays: number[]; overdueDays: number[]; } // жишээ: [3,1,0], [1,3,7]
export interface ReminderCandidate { installmentId: string; dueDate: string; outstanding: number; }
export interface ReminderHit { installmentId: string; kind: ReminderKind; offsetDays: number; key: string; }

/** `asOf` өдөр сануулга илгээх ёстой мөрүүд. key = `${installmentId}:${kind}:${offsetDays}` — давхар илгээхээс сэргийлэх тогтвортой түлхүүр. */
export function remindersFor(asOf: string, candidates: ReminderCandidate[], policy: ReminderPolicy): ReminderHit[] {
  const before = new Set(policy.beforeDueDays.filter((n) => Number.isInteger(n) && n >= 0));
  const overdue = new Set(policy.overdueDays.filter((n) => Number.isInteger(n) && n > 0));
  const hits: ReminderHit[] = [];
  for (const c of candidates) {
    if (c.outstanding <= 0) continue;
    const untilDue = diffDays(asOf, c.dueDate); // >0: ирээдүй, 0: өнөөдөр, <0: хэтэрсэн
    if (untilDue >= 0 && before.has(untilDue)) {
      const kind: ReminderKind = untilDue === 0 ? 'DUE_TODAY' : 'UPCOMING';
      hits.push({ installmentId: c.installmentId, kind, offsetDays: untilDue, key: `${c.installmentId}:${kind}:${untilDue}` });
    } else if (untilDue < 0 && overdue.has(-untilDue)) {
      hits.push({ installmentId: c.installmentId, kind: 'OVERDUE', offsetDays: -untilDue, key: `${c.installmentId}:OVERDUE:${-untilDue}` });
    }
  }
  return hits;
}
