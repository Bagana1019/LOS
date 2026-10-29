// Худалдан авагчийн регистр/утсыг ЗӨВХӨН энэ табын санах ойд (модулийн хувьсагч) хадгална — DECLINED-ийн дараа дахин оролдоход хэрэглэнэ.
// localStorage/sessionStorage/URL/лог-д хэзээ ч бичихгүй (POS-BR-7). Хуудас дахин ачаалахад алга болно — энэ нь зориуд.

export interface BuyerDraft { registerNo: string; phone: string }
const MAX_ENTRIES = 5;
const drafts = new Map<string, BuyerDraft>();

export function rememberBuyer(leaseId: string, buyer: BuyerDraft): void {
  drafts.delete(leaseId);
  drafts.set(leaseId, { ...buyer });
  while (drafts.size > MAX_ENTRIES) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}
export const peekBuyer = (leaseId: string | undefined): BuyerDraft | undefined => (leaseId ? drafts.get(leaseId) : undefined);
export const forgetBuyer = (leaseId: string): void => { drafts.delete(leaseId); };
export function clearBuyerDrafts(): void { drafts.clear(); }
