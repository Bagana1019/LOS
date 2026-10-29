import { ulaanbaatarDate } from '@los/calc';
import type { Clock } from '@los/nest-common';

/** Улаанбаатарын өнөөдөр (YYYY-MM-DD) — ЭТХ-ийн төлөх өдөр, тайлангийн asOf. */
export const todayUB = (clock: Clock): string => ulaanbaatarDate(clock.now());
