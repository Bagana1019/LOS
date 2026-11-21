import type { CollateralListResponse, DecisionRisk, DecisionRiskFlag } from '@los/contracts';
import type { AggregatedIncome } from '../score/score-input.assembler';
import type { CalcSnapshot } from '../score/score.rules';

/**
 * F3-1: шийдвэрийн хуудасны эрсдэлийн хураангуй. ЦЭВЭР уншигч — тооцоолол (`calc_snapshot_json`), барьцааны модуль (`CollateralGateService.snapshot`),
 * орлого (`aggregateIncome`)-ын ХАДГАЛАГДСАН үр дүнг хөрвүүлнэ. Томьёо энд байхгүй (`@los/calc` нь цорын ганц эх сурвалж).
 */
export interface DecisionRiskInput {
  snapshot: CalcSnapshot;
  /** `score` алхам (хуучирсан эсэх). Алхам байхгүй бол null. */
  scoreStep: { status: string; staleReason: string | null } | null;
  collateral: Pick<CollateralListResponse, 'summary' | 'gate' | 'warnings'>;
  income: Pick<AggregatedIncome, 'salaryMonthly' | 'businessNcfMonthly' | 'householdExpenseMonthly'>;
}

const RATIO_FLAG = {
  DTI: { code: 'DTI_ABOVE_LIMIT', message: 'ӨОХ дээд хязгаараас хэтэрсэн' },
  DSCR: { code: 'DSCR_BELOW_MIN', message: 'ӨТЧХ доод хязгаараас бага' },
} as const;

const staleMessage = (reason: string | null): string =>
  `Тооцоолол хуучирсан байна${reason ? `: ${reason}` : ''}. Үзүүлэлтүүд одоогийн нөхцөлтэй таарахгүй байж болно`;

function flagsOf({ snapshot, scoreStep, collateral }: DecisionRiskInput, stale: boolean): DecisionRiskFlag[] {
  const flags: DecisionRiskFlag[] = [
    ...(stale ? [{ code: 'CALCULATION_STALE', level: 'warning' as const, message: staleMessage(scoreStep?.staleReason ?? null) }] : []),
    ...(snapshot.selectedMethod ? [] : [{ code: 'METHOD_NOT_SELECTED', level: 'warning' as const, message: 'Тооцооллын арга сонгогдоогүй байна' }]),
    ...(snapshot.pass === false && snapshot.ratioKind ? [{ ...RATIO_FLAG[snapshot.ratioKind], level: 'error' as const }] : []),
    ...collateral.gate.issues.map((i) => ({ code: i.code, level: 'error' as const, message: i.message })),
    ...collateral.warnings.map((w) => ({ code: w.code, level: 'warning' as const, message: w.message })),
  ];
  const seen = new Set<string>();
  return flags.filter((f) => { const key = `${f.code}|${f.message}`; return seen.has(key) ? false : (seen.add(key), true); });
}

export function buildDecisionRisk(input: DecisionRiskInput): DecisionRisk {
  const { snapshot: s, collateral: c, income } = input;
  const stale = input.scoreStep?.status === 'STALE';
  return {
    method: s.selectedMethod, selection: s.selection, computedAt: s.computedAt, stale,
    ratio: s.ratioKind ? { kind: s.ratioKind, value: s.ratio, limit: s.limit, pass: s.pass } : null,
    ltv: { value: c.summary.ltv, limit: c.summary.ltvLimit, pass: c.summary.ltvPass },
    sosco: { score: Number.isInteger(s.soscoScore) ? s.soscoScore : null, grade: s.soscoGrade },
    collateral: { count: c.summary.count, totalValue: c.summary.totalCollateralValue, required: c.summary.requiresCollateral },
    income: { salaryMonthly: income.salaryMonthly, businessNcfMonthly: income.businessNcfMonthly, householdExpenseMonthly: income.householdExpenseMonthly },
    flags: flagsOf(input, stale),
  };
}
