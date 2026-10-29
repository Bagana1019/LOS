// Ангилагчийн текст нормчлол (NFR-9: латин/кирилл холимог утга). Нимгэн давхарга: бүх үнэн зөв нь @los/ocr-ийн toMatchKey.
import { normalizeAccountNo, normalizeWhitespace, toMatchKey } from '@los/ocr';
import { MATCHING_DEFAULTS } from './classify.defaults';
import type { ClassifiableTxn } from './classify.types';

/** Түлхүүр үгийн хилийн тэмдэгтүүд: үгийн зай ба талбарын тусгаарлагч. toMatchKey-ийн гаралтад '|' хэзээ ч байхгүй. */
export const WORD_SEPARATOR = ' ';
export const FIELD_SEPARATOR = '|';

/** Хоосон/null-д '' өгдөг, урт оролтыг тайрдаг toMatchKey */
export function matchKey(text: string | null | undefined, maxLength: number = MATCHING_DEFAULTS.maxTextLength): string {
  if (typeof text !== 'string' || text === '') return '';
  return toMatchKey(text.length > maxLength ? text.slice(0, maxLength) : text);
}

/** Ангилагч нэг гүйлгээнд нэг л удаа бодож, дүрэм бүрт дахин ашиглах нормчилсон хэлбэр */
export interface PreparedTxn {
  txn: ClassifiableTxn;
  /** `<утга-түлхүүр>|<харьцсан-нэр-түлхүүр>` — түлхүүр үг хайх зөвхөн энэ мөрөөс */
  haystack: string;
  descriptionKey: string;
  counterpartyNameKey: string;
  /** normalizeAccountNo(counterpartyAccount) эсвэл '' */
  account: string;
  /** REGEX дүрэмд: NFKC/зай нормчилсон анхны текст (хойшлуулсан тооцоо) */
  rawText?: string;
}

export function prepareTxn(txn: ClassifiableTxn): PreparedTxn {
  const descriptionKey = matchKey(txn.description);
  const counterpartyNameKey = matchKey(txn.counterpartyName);
  return {
    txn,
    descriptionKey,
    counterpartyNameKey,
    haystack: `${descriptionKey}${FIELD_SEPARATOR}${counterpartyNameKey}`,
    account: txn.counterpartyAccount ? normalizeAccountNo(txn.counterpartyAccount) : '',
  };
}

/** REGEX дүрмийн оролт: анхны (латин/кирилл хэвээр) текст, зай нормчилсон. Нэг удаа тооцоод хадгална. */
export function rawTextOf(p: PreparedTxn): string {
  if (p.rawText === undefined) {
    const { description, counterpartyName } = p.txn;
    const joined = `${description ?? ''} ${FIELD_SEPARATOR} ${counterpartyName ?? ''}`;
    p.rawText = normalizeWhitespace(joined.length > MATCHING_DEFAULTS.maxTextLength ? joined.slice(0, MATCHING_DEFAULTS.maxTextLength) : joined);
  }
  return p.rawText;
}
