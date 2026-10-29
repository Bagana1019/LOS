// BSA ангиллын нийтийн гадаргуу: бусад BSA дэд модуль (import, dti, suspicion) зөвхөн эндээс импортлоно.
export type * from './classify.types';
export { ClassifyModule } from './classify.module';
export { ClassifierService } from './classify.service';
export { classifyTransactions, assertSystemCategories, validateRules, ClassifierConfigError } from './classifier';
export type { ClassifyOptions } from './classifier';
export { CLASSIFY_CONFIDENCE, MATCHING_DEFAULTS, OTHER_GROUP_CODE, OWN_TRANSFER_CONFIDENCE, OWN_TRANSFER_DEFAULTS, RECLASSIFY_DEFAULTS, REGEX_LIMITS, RULE_PRIORITY, SYSTEM_CATEGORY } from './classify.defaults';
export { DEFAULT_BSA_CATEGORIES, DEFAULT_BSA_RULES } from './default-catalog';
export { CHANNEL_KEYWORDS, detectChannel } from './channel';
export { compileRuleSet, evaluateRules } from './rule-engine';
export type { RuleIssue, RuleIssueCode, RuleMatch, RuleSet } from './rule-engine';
export { compileSafeRegex, findUnsafeRegexReason, testSafeRegex } from './regex-guard';
export type { RegexRejectCode, SafeRegexResult } from './regex-guard';
export { collectAccountsFromStatements, detectOwnTransfers, matchOwnAccount, normalizeOwnAccounts, ownAccountKeys } from './own-transfer';
export type { CollectedAccount, OwnTransferDetection, OwnTransferFinding, OwnTransferMethod, OwnTransferOptions, StatementAccountSource } from './own-transfer';
export { computeOtherShare } from './other-share';
export { counterpartyIdentity, descriptionStem, planReclassification, ReclassifyError } from './reclassify';
export type { ReclassificationPlan, ReclassifyErrorCode, ReclassifyInput, SimilarBy } from './reclassify';
export { fromMinor, MinorSum, toMinor, toMinorOrNull } from './money';
