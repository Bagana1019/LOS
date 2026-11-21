import type { DisbursementView } from '@los/contracts';
import { hasMessage, t } from '../../lib/i18n';

// FR-12 · F5-8/9/10: олголтын хуудасны цэвэр логик (I/O, React-гүй) — Playwright-аас гадна vitest-ээр шалгана.

export type HistoryItem = DisbursementView['history'][number];
/** `count` > 1 бол дараалсан ижил ноорог хадгалалтуудыг нэгтгэсэн (at = хамгийн сүүлийнх). */
export interface HistoryRow extends HistoryItem { count: number }

const DRAFT_SAVED = 'DRAFT_UPDATED';
/** Серверийн мөнгөний харьцуулалттай (`money2`) ижил нарийвчлал: 0.005-аас бага зөрүү нь float шуугиан. */
const MONEY_EPSILON = 0.005;

/** F5-9: "Ноорог хадгалах" бүр түүхэнд мөр нэмдэг (16 удаа → 16 мөр). Дараалсан DRAFT_UPDATED-г нэг мөр болгоно; бусад үйлдэл бүр бодит үйл явдал тул хэвээр. */
export function collapseHistory(history: readonly HistoryItem[]): HistoryRow[] {
  return history.reduce<HistoryRow[]>((rows, h) => {
    const prev = rows.at(-1);
    if (h.action === DRAFT_SAVED && prev?.action === DRAFT_SAVED) return [...rows.slice(0, -1), { ...h, count: prev.count + 1 }];
    return [...rows, { ...h, count: 1 }];
  }, []);
}

/** F5-9: татгалзсан хүсэлт ноорог руу буцсан үед сүүлийн татгалзлыг (шалтгаантай) дээд banner-т харуулна. Дахин илгээсэн/батлагдсан бол null. */
export function lastRejection(status: DisbursementView['status'], history: readonly HistoryItem[]): HistoryItem | null {
  if (status !== 'DRAFT') return null;
  return [...history].reverse().find((h) => h.action === 'REJECTED') ?? null;
}

/** Серверийн үйлдлийн код → монгол label. Мэдэгдэхгүй код бол түүхий кодыг буцаана (хоосон label хэзээ ч гаргахгүй). */
export function historyLabel(action: string): string {
  const key = `disb.hist.${action}`;
  return hasMessage(key) ? t(key) : action;
}

export interface TermsFlags { amountDiffers: boolean; thirdParty: boolean }

/** F5-10: батлагч "Зөвшөөрч олгох" дарахаасаа өмнө анхаарах ёстой хоёр зөрүү — олгох дүн ≠ батлагдсан дүн (0 = оруулаагүй), гуравдагч этгээдийн данс. */
export function termsFlags(d: Pick<DisbursementView, 'disburseAmount' | 'approvedAmount' | 'accountOwnerType'>): TermsFlags {
  return {
    amountDiffers: d.disburseAmount > 0 && Math.abs(d.disburseAmount - d.approvedAmount) >= MONEY_EPSILON,
    thirdParty: d.accountOwnerType === 'THIRD_PARTY',
  };
}
