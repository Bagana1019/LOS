import { AttachDocumentRequest, DOCUMENT_OTHER_TYPE, type BorrowerRole, type BorrowerView, type DocumentOcrVerdict, type DocumentView } from '@los/contracts';
import { isMongolianText } from './shared/api-error';
import { t } from '../../lib/i18n';

// Цэвэр логик (React, antd-ээс хамааралгүй) — vitest-ээр тестлэнэ. FR-9.1, FR-9.2 (docs/05 §3.2).

/** Иргэний үнэмлэхийн checklist түлхүүр: энэ мөрийн баримтад OCR тулгалт хийнэ (origination `ID_CARD_CHECKLIST_KEY`). */
export const ID_CARD_CHECKLIST_KEY = 'id_card';
export const isIdCardRow = (checklistKey: string | null | undefined): boolean => checklistKey === ID_CARD_CHECKLIST_KEY;

// ── OCR дүгнэлт ──────────────────────────────────────────────────────────────────────────
export type Tone = 'success' | 'warning' | 'error' | 'default';
export const OCR_VERDICT_TONE: Record<DocumentOcrVerdict, Tone> = { MATCH: 'success', MISMATCH: 'error', UNREADABLE: 'warning', NOT_APPLICABLE: 'default' };
export const ocrVerdictKey = (verdict: DocumentOcrVerdict): string => `document.ocr.verdict.${verdict}`;
export const ocrAdviceKey = (verdict: DocumentOcrVerdict): string => `document.ocr.advice.${verdict}`;

/** OCR-ийн анхааруулга (сервер монголоор өгнө); кирилл биш бол нийтлэг тайлбар. */
export const ocrWarningText = (warning: string): string => (isMongolianText(warning) ? warning : t('document.ocr.warningGeneric'));

// ── оролцогчид (холбогдох зээлдэгч сонгох) ─────────────────────────────────────────────────
export interface BorrowerOption {
  /** `customer.id` — AttachDocumentRequest.relatedId (BORROWER). */
  customerId: string;
  name: string;
  registerMasked: string;
  roles: BorrowerRole[];
}

export function borrowerOptions(items: readonly Pick<BorrowerView, 'customerId' | 'role' | 'customer'>[]): BorrowerOption[] {
  const byCustomer = new Map<string, BorrowerOption>();
  for (const item of items) {
    const existing = byCustomer.get(item.customerId);
    if (existing) existing.roles.push(item.role);
    else byCustomer.set(item.customerId, { customerId: item.customerId, name: item.customer.displayName, registerMasked: item.customer.registerNoMasked, roles: [item.role] });
  }
  return [...byCustomer.values()];
}

export const borrowerOptionLabel = (o: BorrowerOption): string => `${o.name} · ${o.registerMasked} · ${o.roles.map((r) => t(`document.role.${r}`)).join(', ')}`;

/** Баримтын "холбогдох" шошго: зээлдэгч → нэр; хүсэлт → null (шошго үгүй). */
export function relatedLabel(doc: Pick<DocumentView, 'relatedEntity' | 'relatedId'>, options: readonly BorrowerOption[]): string | null {
  if (doc.relatedEntity === 'BORROWER') {
    const o = options.find((x) => x.customerId === doc.relatedId);
    return o ? t('document.related.borrower', { name: o.name }) : t('document.related.borrowerUnknown');
  }
  if (doc.relatedEntity === 'COLLATERAL') return t('document.related.COLLATERAL');
  return null;
}

// ── хавсаргах хүсэлт ─────────────────────────────────────────────────────────────────────
export type AttachTarget = { kind: 'checklist'; key: string; name: string } | { kind: 'extra' };

export interface AttachDraft {
  target: AttachTarget;
  fileId: string;
  /** Зээлдэгчид холбох бол `customer.id`; хоосон → хүсэлтэд (APPLICATION). */
  borrowerId?: string | null;
  note?: string | null;
}

export type AttachBuild = { ok: true; body: AttachDocumentRequest } | { ok: false; field: 'file' | 'note' | 'borrower'; message: string };

/** Нэмэлт баримтад тайлбар заавал (checklist-д ороогүй тул юу болохыг тайлбараас л мэднэ). Файл байршуулахаас ӨМНӨ шалгана — хоосон тайлбартай оролдлого dms-д илүү файл үлдээхгүй. */
export const attachNoteError = (target: AttachTarget, note: string | null | undefined): string | null =>
  target.kind === 'extra' && !note?.trim() ? t('document.validation.noteRequired') : null;

/** Checklist мөр → `checklistKey`; нэмэлт → `type: 'other'` + тайлбар (note) заавал. Эцсийн шалгалт `AttachDocumentRequest` схем. */
export function buildAttachRequest(d: AttachDraft): AttachBuild {
  const note = d.note?.trim() || undefined;
  const noteError = attachNoteError(d.target, note);
  if (noteError) return { ok: false, field: 'note', message: noteError };
  const candidate = {
    fileId: d.fileId,
    ...(d.target.kind === 'checklist' ? { checklistKey: d.target.key } : { type: DOCUMENT_OTHER_TYPE }),
    relatedEntity: d.borrowerId ? 'BORROWER' : 'APPLICATION',
    ...(d.borrowerId ? { relatedId: d.borrowerId } : {}),
    ...(note ? { note } : {}),
  };
  const parsed = AttachDocumentRequest.safeParse(candidate);
  if (parsed.success) return { ok: true, body: parsed.data };
  const issue = parsed.error.issues[0];
  const path = String(issue?.path[0] ?? '');
  return { ok: false, field: path === 'note' ? 'note' : path === 'relatedId' ? 'borrower' : 'file', message: issue && isMongolianText(issue.message) ? issue.message : t('document.validation.invalid') };
}

// ── хураангуй ────────────────────────────────────────────────────────────────────────────
export interface DocumentSummaryLike {
  productMissing: boolean;
  required: number;
  satisfied: number;
  complete: boolean;
  missing: readonly string[];
}
export type SummaryState = 'productMissing' | 'complete' | 'incomplete' | 'noRequired';
export const summaryState = (s: DocumentSummaryLike): SummaryState => (s.productMissing ? 'productMissing' : s.required === 0 ? 'noRequired' : s.complete ? 'complete' : 'incomplete');
