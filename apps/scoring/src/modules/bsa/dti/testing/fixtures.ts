// DTI тестийн fixture. БҮХ ӨГӨГДӨЛ СИНТЕТИК; босго/жин нь зөвхөн тестийнх (бизнесийн анхдагч биш — admin тохиргоо).
import type { BsaSettings } from '../../common/infra.ports';

export const TEST_SETTINGS: BsaSettings = {
  costOfGoodsRate: 0.1, maxDti: 0.55, dtiLevelThresholds: { lowMax: 0.35, mediumMax: 0.55 }, otherShareThreshold: 0.3,
  allowedPeriodMonths: [3, 6, 12], minStatementMonths: 6, retentionYears: 3,
  businessIncomeCodes: ['BUSINESS_INCOME'], irregularIncomeCodes: ['IRREGULAR_INCOME', 'ABNORMAL_INCOME', 'SUSPICIOUS_INCOME'],
  reliabilityWeights: { frequency: 0.4, consistency: 0.4, cleanliness: 0.2 }, balanceTolerance: 0.01,
  pushPolicyWhenPendingSuspicious: 'WARN', maxUploadBytes: 10_000_000, maxFilesPerUpload: 5,
};
