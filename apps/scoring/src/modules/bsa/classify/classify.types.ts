// BSA ангиллын гэрээ. docs/02 §4 (ангилал, дайчлах хувь), BSA-FR-3, BSA-BR-5/7.
import type { BsaDtiRole, BsaRuleMatchType, BsaRuleSource, TxnChannel, TxnDirection } from '@los/contracts';

/** docs/03 bsa_category — admin-д тохируулагдана */
export interface BsaCategoryDef {
  code: string;
  direction: TxnDirection;
  /** A, B, C, D, E, F, G, CH, '?' , '—' (docs/02 §4) */
  groupCode: string;
  name: string; // монгол нэр
  /** Дайчлах хувь 0..1 (INCOME), зарлагад 1 */
  weight: number;
  dtiRole: BsaDtiRole;
  isActive: boolean;
}

/** docs/03 bsa_rule */
export interface BsaRuleDef {
  id?: string;
  direction: TxnDirection;
  matchType: BsaRuleMatchType;
  /** KEYWORD: нормчилсон дэд мөр (латин/кирилл холимог зөвшөөрнө); COUNTERPARTY: дансны дугаар/нэр; REGEX: RegExp эх */
  pattern: string;
  categoryCode: string;
  /** Их утга түрүүлж шалгагдана */
  priority: number;
  source: BsaRuleSource;
}

/** Ангилагчид өгөх гүйлгээ (parser-ийн гаралт + DB-ээс ирсэн) */
export interface ClassifiableTxn {
  /** DB id эсвэл түр түлхүүр — own-transfer хос тааруулахад хэрэгтэй */
  key: string;
  /** Аль хуулга/дансны гүйлгээ вэ (own-transfer: өөр хуулгын хос хайхад) */
  statementKey: string;
  bank: string | null;
  txnDate: string; // YYYY-MM-DD
  txnTime: string | null;
  direction: TxnDirection;
  amount: number;
  description: string;
  counterpartyAccount: string | null;
  counterpartyName: string | null;
  /** Гар засвар → ангилагч дахин өөрчлөхгүй */
  manualCategoryCode?: string | null;
}

export interface ClassificationContext {
  categories: BsaCategoryDef[];
  rules: BsaRuleDef[];
  /** Харилцагчийн бүх данс (дугаар/IBAN) — BSA-BR-5 */
  ownAccounts: string[];
  /** Харилцагчийн нэр (Голомт: утганд нэр байвал өөрийн данс) */
  customerNames: string[];
}

export interface ClassificationResult {
  key: string;
  categoryCode: string;
  categoryGroup: string;
  /** 0..100 (docs/02 §5: итгэл %) */
  confidence: number;
  channel: TxnChannel;
  isOwnTransfer: boolean;
  /** Тайлбарлах шалтгаан (аудит/UI): таарсан дүрэм, own-transfer шалтгаан гэх мэт */
  reason: string;
  matchedRuleId?: string | null;
}

/** BSA-BR-7 */
export interface OtherShareReport {
  direction: TxnDirection;
  otherAmount: number;
  totalAmount: number;
  /** 0..1 */
  share: number;
  exceeded: boolean;
}

/** ADDITIVE: гүйлгээ + түүний ангиллын үр дүн (aggregate, other-share, reclassify нийтээр ашиглана) */
export interface ClassifiedTxn {
  txn: ClassifiableTxn;
  result: ClassificationResult;
}
