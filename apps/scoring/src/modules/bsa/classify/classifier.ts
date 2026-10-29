// BSA-FR-3.1: гүйлгээ бүрийг §4 ангилалд оноох. Дараалал (тодорхой, deterministic):
//   1. гар засвар (manualCategoryCode)  2. өөрийн данс хоорондын шилжүүлэг (BSA-BR-5)  3. дүрмийн сан (rule-engine)
//   4. суваг (QPAY/POS/ATM зарлага → CHANNEL_EXPENSE)  5. бусад (OTHER_INCOME / OTHER_EXPENSE).
// Түлхүүрүүдийг гүйлгээ бүрт НЭГ удаа нормчилж (prepareTxn), дүрмийг НЭГ удаа compile хийнэ → O(n·дүрэм).
import { CLASSIFY_CONFIDENCE, OTHER_GROUP_CODE, SYSTEM_CATEGORY } from './classify.defaults';
import type { BsaCategoryDef, BsaRuleDef, ClassifiableTxn, ClassificationContext, ClassificationResult } from './classify.types';
import { channelOfHaystack } from './channel';
import { prepareTxn, type PreparedTxn } from './normalize';
import { detectOwnTransfers, type OwnTransferFinding, type OwnTransferOptions } from './own-transfer';
import { compileRuleSet, evaluateRules, type RuleIssue, type RuleSet } from './rule-engine';

export interface ClassifyOptions {
  ownTransfer?: OwnTransferOptions;
}

/** Ангиллын сан системийн шаардлагыг хангахгүй (жишээ нь OTHER_INCOME устгагдсан) */
export class ClassifierConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassifierConfigError';
  }
}

const REQUIRED_SYSTEM_CATEGORIES: ReadonlyArray<[code: string, direction: BsaCategoryDef['direction']]> = [
  [SYSTEM_CATEGORY.OWN_TRANSFER_INCOME, 'INCOME'],
  [SYSTEM_CATEGORY.OWN_TRANSFER_EXPENSE, 'EXPENSE'],
  [SYSTEM_CATEGORY.OTHER_INCOME, 'INCOME'],
  [SYSTEM_CATEGORY.OTHER_EXPENSE, 'EXPENSE'],
  [SYSTEM_CATEGORY.CHANNEL_EXPENSE, 'EXPENSE'],
];

/** Системийн ангилал бүр зөв чиглэлтэйгээр байгааг шалгана (байхгүй бол чимээгүй буруу ангилахын оронд тодорхой алдаа) */
export function assertSystemCategories(categories: readonly BsaCategoryDef[]): Map<string, BsaCategoryDef> {
  const byCode = new Map(categories.map((c) => [c.code, c]));
  const problems = REQUIRED_SYSTEM_CATEGORIES.filter(([code, direction]) => byCode.get(code)?.direction !== direction).map(([code]) => code);
  if (problems.length > 0) throw new ClassifierConfigError(`required system categories are missing or have a wrong direction: ${problems.join(', ')}`);
  return byCode;
}

function ruleReason(rule: BsaRuleDef): string {
  // FEEDBACK дүрмийн хэв нь гүйлгээний утгаас гарсан тул (хувийн нэр орсон байж болно) тайлбарт давтахгүй
  return rule.source === 'ADMIN' ? `Дүрэм (${rule.matchType} «${rule.pattern}», priority ${rule.priority})` : `Дүрэм (FEEDBACK ${rule.matchType}, priority ${rule.priority})`;
}

function classifyPrepared(
  p: PreparedTxn,
  finding: OwnTransferFinding | null,
  ruleSet: RuleSet,
  byCode: ReadonlyMap<string, BsaCategoryDef>,
): ClassificationResult {
  const { txn } = p;
  const channel = channelOfHaystack(p.haystack, typeof txn.counterpartyAccount === 'string' && txn.counterpartyAccount.trim() !== '');
  const groupOf = (code: string): string => byCode.get(code)?.groupCode ?? OTHER_GROUP_CODE;
  const result = (categoryCode: string, confidence: number, reason: string, extra: Partial<ClassificationResult> = {}): ClassificationResult => ({
    key: txn.key, categoryCode, categoryGroup: groupOf(categoryCode), confidence, channel, isOwnTransfer: false, reason, matchedRuleId: null, ...extra,
  });

  if (txn.manualCategoryCode) {
    return result(txn.manualCategoryCode, CLASSIFY_CONFIDENCE.MANUAL, 'Гар засвар (хэрэглэгчийн шийдвэр)');
  }
  if (finding) {
    const code = txn.direction === 'INCOME' ? SYSTEM_CATEGORY.OWN_TRANSFER_INCOME : SYSTEM_CATEGORY.OWN_TRANSFER_EXPENSE;
    return result(code, finding.confidence, finding.reason, { isOwnTransfer: true });
  }
  const match = evaluateRules(p, ruleSet);
  if (match) return result(match.rule.categoryCode, match.confidence, ruleReason(match.rule), { matchedRuleId: match.rule.id ?? null });
  if (txn.direction === 'EXPENSE' && (channel === 'QPAY' || channel === 'POS' || channel === 'ATM')) {
    return result(SYSTEM_CATEGORY.CHANNEL_EXPENSE, CLASSIFY_CONFIDENCE.CHANNEL_FALLBACK, `Суваг ${channel}: түлхүүр үг таараагүй тул сувгийн зарлага`);
  }
  const other = txn.direction === 'INCOME' ? SYSTEM_CATEGORY.OTHER_INCOME : SYSTEM_CATEGORY.OTHER_EXPENSE;
  return result(other, CLASSIFY_CONFIDENCE.UNMATCHED, 'Таарсан дүрэм олдсонгүй');
}

/** Дүрмийн сангийн алдааг (таслагдсан дүрэм) admin-д харуулахад: ангилалтай хамт шалгана. Ангилагч ийм дүрмийг өөрөө алгасдаг. */
export function validateRules(rules: readonly BsaRuleDef[], categories: readonly BsaCategoryDef[]): RuleIssue[] {
  return compileRuleSet(rules, categories).issues;
}

/**
 * Гүйлгээнүүдийг ангилна. Гаралт нь `txns`-тэй индексээр зэрэгцсэн. Цэвэр, deterministic (цаг/санамсаргүй утгагүй).
 * Буруу дүрэм (аюултай regex, үл мэдэгдэх ангилал…) алгасагдана — тэдгээрийг `validateRules`-аар харна.
 * Системийн ангилал (OWN_TRANSFER_IN, NON_EXPENSE, OTHER_*, CHANNEL_EXPENSE) дутвал ClassifierConfigError.
 */
export function classifyTransactions(
  txns: readonly ClassifiableTxn[],
  ctx: ClassificationContext,
  opts: ClassifyOptions = {},
): ClassificationResult[] {
  const byCode = assertSystemCategories(ctx.categories);
  const ruleSet = compileRuleSet(ctx.rules, ctx.categories);
  const { findings } = detectOwnTransfers(txns, ctx, opts.ownTransfer);
  return txns.map((txn, i) => classifyPrepared(prepareTxn(txn), findings[i], ruleSet, byCode));
}
