// Stateless Nest wrapper: ангилагчийн цэвэр функцүүдийг DI-аар (дараа нь import pipeline, reclassify API) ашиглуулна.
import { Injectable } from '@nestjs/common';
import { detectChannel, type ChannelInput } from './channel';
import { classifyTransactions, validateRules, type ClassifyOptions } from './classifier';
import type {
  BsaCategoryDef, BsaRuleDef, ClassifiableTxn, ClassificationContext, ClassificationResult, ClassifiedTxn, OtherShareReport,
} from './classify.types';
import { computeOtherShare } from './other-share';
import { detectOwnTransfers, type OwnTransferDetection, type OwnTransferOptions } from './own-transfer';
import { planReclassification, type ReclassificationPlan, type ReclassifyInput } from './reclassify';
import type { RuleIssue } from './rule-engine';

@Injectable()
export class ClassifierService {
  /** BSA-FR-3.1: ангилах (манай гар засвар → өөрийн данс → дүрэм → суваг → бусад) */
  classify(txns: readonly ClassifiableTxn[], ctx: ClassificationContext, opts?: ClassifyOptions): ClassificationResult[] {
    return classifyTransactions(txns, ctx, opts);
  }

  /** BSA-BR-5 */
  detectOwnTransfers(txns: readonly ClassifiableTxn[], ctx: Pick<ClassificationContext, 'ownAccounts' | 'customerNames'>, opts?: OwnTransferOptions): OwnTransferDetection {
    return detectOwnTransfers(txns, ctx, opts);
  }

  detectChannel(txn: ChannelInput) {
    return detectChannel(txn);
  }

  /** BSA-BR-7 */
  otherShare(classified: readonly ClassifiedTxn[], categories: readonly BsaCategoryDef[], threshold: number): OtherShareReport[] {
    return computeOtherShare(classified, categories, threshold);
  }

  /** BSA-FR-3.3 / 3.4 */
  planReclassification(input: ReclassifyInput): ReclassificationPlan {
    return planReclassification(input);
  }

  /** BSA-FR-3.5: admin дүрэм хадгалахын өмнө буруу дүрмийг илрүүлэх */
  validateRules(rules: readonly BsaRuleDef[], categories: readonly BsaCategoryDef[]): RuleIssue[] {
    return validateRules(rules, categories);
  }
}
