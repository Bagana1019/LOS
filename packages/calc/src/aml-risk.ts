// AML эрсдэлийн оноо (FR-2.5) — цэвэр функц, I/O байхгүй.
// Жин, босго бүгд policy-аас ирнэ (CLAUDE.md 6.2): энд BR тоо hardcode хийхгүй.
// Төрлүүд нь @los/contracts-ийн AmlPolicy['risk']-тэй бүтцээрээ таарна (calc нь contracts-ийн runtime-д найдахгүй).
export interface AmlRiskWeights {
  pep: number; relatedParty: number; fatfIncreasedMonitoring: number; fatfCallForAction: number;
  internalBlacklist: number; sanctionsPossible: number; sanctionsConfirmed: number;
}
export interface AmlRiskPolicy { weights: AmlRiskWeights; mediumFrom: number; highFrom: number }
export interface AmlRiskInput {
  isPep: boolean;
  isRelatedParty: boolean;
  fatfCategory: 'CALL_FOR_ACTION' | 'INCREASED_MONITORING' | null;
  internalBlacklistHit: boolean;
  /** POSSIBLE ба CONFIRMED нэгэн зэрэг үл тохиолдоно: CONFIRMED давамгайлна. */
  sanctions: 'NONE' | 'POSSIBLE' | 'CONFIRMED';
}
export interface AmlRiskFactorOut { code: string; weight: number; detail?: string }
export interface AmlRiskResult { score: number; level: 'LOW' | 'MEDIUM' | 'HIGH'; factors: AmlRiskFactorOut[] }

const inScale = (n: number) => n >= 0 && n <= 100;

function assertPolicy({ weights, mediumFrom, highFrom }: AmlRiskPolicy): void {
  if (Object.values(weights).some((w) => !(w >= 0))) throw new RangeError('AML risk weights must not be negative');
  if (!inScale(mediumFrom) || !inScale(highFrom)) throw new RangeError('AML risk thresholds must be within 0..100');
  if (mediumFrom > highFrom) throw new RangeError('AML risk mediumFrom must not exceed highFrom');
}

export function amlRisk(input: AmlRiskInput, policy: AmlRiskPolicy): AmlRiskResult {
  assertPolicy(policy);
  const w = policy.weights;
  const factors: AmlRiskFactorOut[] = [];
  const add = (applies: boolean, code: string, weight: number) => { if (applies) factors.push({ code, weight }); };
  // Factor-ын дараалал тогтмол (тест, аудит харьцуулахад).
  add(input.isPep, 'PEP', w.pep);
  add(input.isRelatedParty, 'RELATED_PARTY', w.relatedParty);
  add(input.fatfCategory === 'INCREASED_MONITORING', 'FATF_INCREASED_MONITORING', w.fatfIncreasedMonitoring);
  add(input.fatfCategory === 'CALL_FOR_ACTION', 'FATF_CALL_FOR_ACTION', w.fatfCallForAction);
  add(input.internalBlacklistHit, 'INTERNAL_BLACKLIST', w.internalBlacklist);
  add(input.sanctions === 'POSSIBLE', 'SANCTIONS_POSSIBLE', w.sanctionsPossible);
  add(input.sanctions === 'CONFIRMED', 'SANCTIONS_CONFIRMED', w.sanctionsConfirmed);

  const sum = factors.reduce((acc, f) => acc + f.weight, 0);
  const score = Math.round(Math.min(100, sum) * 100) / 100;
  // Баталгаажсан хориг жагсаалтын тохирол бодлогын утгаас үл хамааран үргэлж HIGH.
  const level = input.sanctions === 'CONFIRMED' || score >= policy.highFrom ? 'HIGH' : score >= policy.mediumFrom ? 'MEDIUM' : 'LOW';
  return { score, level, factors };
}
