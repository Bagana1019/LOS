import {
  ProductDocumentChecklist,
  type ApplicationDocumentsResponse,
  type DocumentChecklistItem,
  type DocumentChecklistStatus,
  type DocumentSummary,
  type DocumentView,
} from '@los/contracts';

// Цэвэр дүрмүүд (I/O байхгүй) — docs/01 FR-9.1, FR-9.2; docs/05-collateral-documents.md §3.2.
// Checklist = `product.document_checklist_json` (`[{key, name, required}]`). Заавал түлхүүр бүрт ≥ 1 баримт байвал 8-р алхам (`document`) COMPLETED.

/**
 * Түлхүүрийг харьцуулахад тогтвортой хэлбэрт оруулна: trim → NFC → жижиг үсэг → дотоод хоосон зай `_`.
 * dms `document.rules.ts`-ийн `normalizeKey`-тэй ИЖИЛ байх ёстой — dms хадгалахдаа түлхүүрийг нормчилдог тул
 * энд ч нормчилсон хэлбэрээр тулгана (бүтээгдэхүүний тохиргоонд `ID_CARD` гэж байсан ч `id_card` баримттай таарна).
 */
export function normalizeKey(raw: string): string {
  return raw.trim().normalize('NFC').toLowerCase().replace(/\s+/g, '_');
}

/** DEMO: иргэний үнэмлэхийн checklist түлхүүр (seed-ийн бүтээгдэхүүний checklist). OCR тулгалт зөвхөн энэ түлхүүртэй баримтад хийгдэнэ. Солих ганц газар. */
export const ID_CARD_CHECKLIST_KEY = 'id_card';

export interface ParsedChecklist {
  /** Хүчинтэй checklist. Түлхүүр давхардвал эхнийх нь л үлдэнэ. */
  items: ProductDocumentChecklist;
  /** `true` — JSON байгаа ч `ProductDocumentChecklist`-д нийцээгүй (тохиргооны алдаа) тул checklist хоосон гэж үзсэн. null/undefined бол `false`. */
  invalid: boolean;
}

/** `product.document_checklist_json` → checklist. Байхгүй (null) эсвэл буруу хэлбэр → хоосон checklist (FR-9.2: тодорхойгүй бол шаардлага үүсгэхгүй). */
export function parseProductChecklist(json: unknown): ParsedChecklist {
  if (json === null || json === undefined) return { items: [], invalid: false };
  const parsed = ProductDocumentChecklist.safeParse(json);
  if (!parsed.success) return { items: [], invalid: true };
  const seen = new Set<string>();
  const items: DocumentChecklistItem[] = [];
  for (const item of parsed.data) {
    const key = normalizeKey(item.key);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return { items, invalid: false };
}

/** Түлхүүрээр (нормчилж) checklist-ийн мөрийг олно. */
export function findChecklistItem(checklist: readonly DocumentChecklistItem[], key: string): DocumentChecklistItem | undefined {
  const wanted = normalizeKey(key);
  return checklist.find((i) => normalizeKey(i.key) === wanted);
}

/**
 * Барьцааны баримт (`relatedEntity = COLLATERAL`) нь барьцааны өөрийн checklist-д (FR-6.7) хамаарах тул хүсэлтийн checklist/extras-д орохгүй.
 * Түлхүүртэй баримт `relatedEntity`-ээс үл хамааран (хүсэлт, зээлдэгч) түлхүүрийг хангана.
 */
const isApplicationDocument = (d: DocumentView): boolean => d.relatedEntity !== 'COLLATERAL';

export interface ChecklistInput {
  /** Хүсэлтэд бүтээгдэхүүн (4-р алхам) сонгогдсон, бүртгэлтэй эсэх. */
  productPresent: boolean;
  checklist: readonly DocumentChecklistItem[];
  /** dms-ийн жагсаалт (оруулсан дарааллаар). */
  documents: readonly DocumentView[];
}

/**
 * Checklist-ийн төлөв, нэмэлт баримт, хураангуй.
 *  - `checklist[]` — product-ийн дарааллаар; мөр бүрийн `documents` = тухайн түлхүүртэй баримтууд, `satisfied` = ≥ 1 баримт.
 *  - `extras` — түлхүүргүй эсвэл checklist-д байхгүй түлхүүртэй баримт (`type: other` г.м).
 *  - `summary.complete` = бүтээгдэхүүн байгаа БА заавал мөр бүр хангагдсан. Бүтээгдэхүүнгүй бол `complete=false` (checklist тодорхойгүй).
 *  - `summary.missing` = хангагдаагүй заавал мөрийн ТҮЛХҮҮРҮҮД.
 */
export function buildApplicationDocuments(input: ChecklistInput): ApplicationDocumentsResponse {
  const documents = input.documents.filter(isApplicationDocument);
  const checklist = input.productPresent ? input.checklist : [];
  const byKey = new Map<string, DocumentView[]>();
  for (const d of documents) {
    if (!d.checklistKey) continue;
    const key = normalizeKey(d.checklistKey);
    const list = byKey.get(key);
    if (list) list.push(d); else byKey.set(key, [d]);
  }
  const known = new Set(checklist.map((i) => normalizeKey(i.key)));
  const statuses: DocumentChecklistStatus[] = checklist.map((item) => {
    const docs = byKey.get(normalizeKey(item.key)) ?? [];
    return { key: item.key, name: item.name, required: item.required, satisfied: docs.length > 0, documents: docs };
  });
  const extras = documents.filter((d) => !d.checklistKey || !known.has(normalizeKey(d.checklistKey)));
  const required = statuses.filter((s) => s.required);
  const missing = required.filter((s) => !s.satisfied).map((s) => s.key);
  const summary: DocumentSummary = {
    productMissing: !input.productPresent,
    required: required.length,
    satisfied: required.length - missing.length,
    complete: input.productPresent && missing.length === 0,
    missing,
  };
  return { items: [...documents], checklist: statuses, extras, summary };
}

// ── 8-р алхам (`document`) ───────────────────────────────────────────────────────────
export interface DocumentStepRow { id: string; status: string }
export interface DocumentStepUpdate { id: string; status: 'COMPLETED' | 'PENDING'; staleReason: null; completedAt: Date | null }

/**
 * FR-9.2: заавал баримт бүрэн → COMPLETED (`completed_at` = now), үгүй бол PENDING (`completed_at` = null).
 * LOCKED алхамд хүрэхгүй (өмнөх алхмууд дуусаагүй — Модуль 2 нээнэ). Алхмын мөр байхгүй бол юу ч хийхгүй. Өөрчлөлт байхгүй бол null.
 */
export function planDocumentStep(step: DocumentStepRow | null | undefined, complete: boolean, now: Date): DocumentStepUpdate | null {
  if (!step || step.status === 'LOCKED') return null;
  const status = complete ? 'COMPLETED' : 'PENDING';
  if (step.status === status) return null;
  return { id: step.id, status, staleReason: null, completedAt: complete ? now : null };
}

/** Хоёр жагсаалт ижил баримтуудтай эсэх (дарааллаас үл хамаарна). Алхмын тооцоо зөвхөн баримтын `id` ба түлхүүрээс хамаарна. */
export function sameDocuments(a: readonly DocumentView[], b: readonly DocumentView[]): boolean {
  if (a.length !== b.length) return false;
  const sig = (docs: readonly DocumentView[]) => docs.map((d) => `${d.id}|${d.checklistKey ?? ''}|${d.relatedEntity}`).sort().join('\n');
  return sig(a) === sig(b);
}
