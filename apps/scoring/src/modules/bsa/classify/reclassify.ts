// BSA-FR-3.3 / 3.4 (docs/02 §2 "Ангилал өөрчлөх"): сонгосон гүйлгээг зорилтот ангилалд шилжүүлэх төлөвлөгөө.
//  - "Ижил утгатай бүх гүйлгээнд хэрэглэх" (bulk): утгын "үндэс"-ээр (тоо/огноо/лавлагааны дугаар хассан toMatchKey) эсвэл харьцсан дансаар.
//  - Чиглэл зорилтот ангиллын чиглэлтэй таарах ёстой (орлогыг зарлагын ангилалд оруулахгүй) — зөрвөл ReclassifyError.
//  - Гар засварыг дүрмийн санд санал болгоно: source FEEDBACK, priority = RULE_PRIORITY.FEEDBACK (анхдагчаас дээш, ADMIN дарах дүрмээс доош).
// АНХААР (PII): санал болгосон дүрмийн хэв гүйлгээний утгаас гарсан тул хүний нэр орсон байж болно. Дүрмийн санд хадгалахаас өмнө
// admin/ЗЭЗ хянаж баталгаажуулах ёстой — энэ функц зөвхөн санал болгоно, хадгалахгүй.
import { normalizeAccountNo } from '@los/ocr';
import { RECLASSIFY_DEFAULTS, RULE_PRIORITY } from './classify.defaults';
import type { BsaCategoryDef, BsaRuleDef, ClassifiableTxn } from './classify.types';
import { matchKey } from './normalize';

export type SimilarBy = 'DESCRIPTION' | 'COUNTERPARTY';

export interface ReclassifyInput {
  txns: readonly ClassifiableTxn[];
  selectedKeys: readonly string[];
  targetCategoryCode: string;
  /** "ижил утгатай бүх гүйлгээнд хэрэглэх" */
  applyToSimilar: boolean;
  similarBy: SimilarBy;
  /** ADDITIVE (зорилтот ангиллын чиглэл/идэвхтэй эсэхийг шалгахад шаардлагатай) */
  categories: readonly BsaCategoryDef[];
}

export interface ReclassificationPlan {
  /** Шилжүүлэгдэх бүх гүйлгээний key (сонгосон + ижил), `txns`-ийн эрэмбээр */
  affectedKeys: string[];
  /** Гар засварыг дүрмийн санд санал болгох (FEEDBACK); ерөнхийлж болохгүй бол null */
  suggestedRule: BsaRuleDef | null;
  /** Хэрэглэгчийн сонгосон (шалгагдсан) key-үүд */
  selectedKeys: string[];
  /** applyToSimilar-аар нэмэгдсэн (сонгоогүй) key-үүд */
  similarKeys: string[];
}

export type ReclassifyErrorCode = 'EMPTY_SELECTION' | 'UNKNOWN_CATEGORY' | 'CATEGORY_INACTIVE' | 'SELECTION_NOT_FOUND' | 'DIRECTION_MISMATCH';

/** Алдааны мессежид гүйлгээний агуулга (PII) орохгүй — зөвхөн код, тоо */
export class ReclassifyError extends Error {
  constructor(readonly code: ReclassifyErrorCode, message: string) {
    super(message);
    this.name = 'ReclassifyError';
  }
}

/**
 * Утгын "үндэс": toMatchKey → үг бүрээс цифр хасна. Цэвэр тоо, 1 үсэгтэй үг хаягдана; үсэг+цифр холимог (лавлагаа 'trx12345') үгийн
 * үсгийн хэсэг ≥ 3 бол үлдэнэ. 'Цалин 2026-03 #1234' ба 'Цалин 2026-04 #1299' → 'tsalin'. Үндэс богино (< minStemLength) бол ''.
 */
export function descriptionStem(description: string | null | undefined): string {
  const tokens: string[] = [];
  for (const token of matchKey(description).split(' ')) {
    const letters = token.replace(/\d+/g, '');
    if (letters === '') continue;
    const hadDigits = letters.length !== token.length;
    if (hadDigits ? letters.length >= 3 : letters.length >= RECLASSIFY_DEFAULTS.minTokenLetters) tokens.push(letters);
  }
  const stem = tokens.join(' ');
  return stem.length >= RECLASSIFY_DEFAULTS.minStemLength ? stem : '';
}

interface CounterpartyIdentity {
  matchType: 'ACCOUNT' | 'NAME';
  value: string;
}

/** Харьцсан тал: данс (бүтэн, далдалаагүй) → нэр → null */
export function counterpartyIdentity(txn: Pick<ClassifiableTxn, 'counterpartyAccount' | 'counterpartyName'>): CounterpartyIdentity | null {
  const rawAccount = txn.counterpartyAccount;
  if (typeof rawAccount === 'string' && !/[*•●#xX]/.test(rawAccount)) {
    const account = normalizeAccountNo(rawAccount);
    if (account.length >= 6) return { matchType: 'ACCOUNT', value: account };
  }
  const name = matchKey(txn.counterpartyName);
  return name.length >= RECLASSIFY_DEFAULTS.minStemLength ? { matchType: 'NAME', value: name } : null;
}

const identityKey = (id: CounterpartyIdentity): string => `${id.matchType}:${id.value}`;

export function planReclassification(input: ReclassifyInput): ReclassificationPlan {
  const { txns, targetCategoryCode, applyToSimilar, similarBy } = input;
  const target = input.categories.find((c) => c.code === targetCategoryCode);
  if (!target) throw new ReclassifyError('UNKNOWN_CATEGORY', `target category "${targetCategoryCode}" does not exist`);
  if (!target.isActive) throw new ReclassifyError('CATEGORY_INACTIVE', `target category "${targetCategoryCode}" is inactive`);

  const selectedSet = new Set(input.selectedKeys);
  if (selectedSet.size === 0) throw new ReclassifyError('EMPTY_SELECTION', 'no transactions were selected');
  const selected = txns.filter((t) => selectedSet.has(t.key));
  if (new Set(selected.map((t) => t.key)).size !== selectedSet.size) {
    throw new ReclassifyError('SELECTION_NOT_FOUND', `${selectedSet.size - new Set(selected.map((t) => t.key)).size} selected key(s) are not among the transactions`);
  }
  const mismatched = selected.filter((t) => t.direction !== target.direction).length;
  if (mismatched > 0) {
    throw new ReclassifyError('DIRECTION_MISMATCH', `${mismatched} selected transaction(s) are not ${target.direction}; category "${target.code}" is a ${target.direction} category`);
  }

  // Ижил байдлын "дарга" утгууд: сонгосон гүйлгээ бүрийн үндэс / харьцсан тал
  const selectedValues = selected.map((t) => (similarBy === 'DESCRIPTION' ? descriptionStem(t.description) : counterpartyIdentity(t)));
  const similarSet = new Set<string>();
  for (const v of selectedValues) {
    if (typeof v === 'string' && v !== '') similarSet.add(v);
    else if (v && typeof v === 'object') similarSet.add(identityKey(v));
  }
  const similarKey = (t: ClassifiableTxn): string | null => {
    if (similarBy === 'DESCRIPTION') return descriptionStem(t.description) || null;
    const id = counterpartyIdentity(t);
    return id ? identityKey(id) : null;
  };

  const similarKeys: string[] = [];
  const affectedKeys: string[] = [];
  for (const t of txns) {
    if (selectedSet.has(t.key)) {
      affectedKeys.push(t.key);
      continue;
    }
    // Гар засвартай гүйлгээг (өмнөх хэрэглэгчийн шийдвэр) bulk-аар дарахгүй; чиглэл зөрсөн гүйлгээнд хүрэхгүй
    if (!applyToSimilar || t.manualCategoryCode || t.direction !== target.direction) continue;
    const k = similarKey(t);
    if (k !== null && similarSet.has(k)) {
      similarKeys.push(t.key);
      affectedKeys.push(t.key);
    }
  }

  return { affectedKeys, suggestedRule: suggestRule(selected, selectedValues, similarBy, target), selectedKeys: selected.map((t) => t.key), similarKeys };
}

/** Сонгосон бүх гүйлгээ НЭГ үндэс/харьцсан талтай бол л дүрэм санал болгоно (холимог сонголтыг таамаглахгүй) */
function suggestRule(
  selected: readonly ClassifiableTxn[],
  values: ReadonlyArray<string | CounterpartyIdentity | null>,
  similarBy: SimilarBy,
  target: BsaCategoryDef,
): BsaRuleDef | null {
  if (selected.length === 0 || values.some((v) => v === null || v === '')) return null;
  const base = { direction: target.direction, categoryCode: target.code, priority: RULE_PRIORITY.FEEDBACK, source: 'FEEDBACK' } as const;
  if (similarBy === 'DESCRIPTION') {
    const stems = new Set(values as string[]);
    return stems.size === 1 ? { ...base, matchType: 'KEYWORD', pattern: [...stems][0] } : null;
  }
  const ids = values as CounterpartyIdentity[];
  const distinct = new Set(ids.map(identityKey));
  return distinct.size === 1 ? { ...base, matchType: 'COUNTERPARTY', pattern: ids[0].value } : null;
}
