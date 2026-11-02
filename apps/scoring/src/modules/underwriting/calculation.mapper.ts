// scoring.calculation мөр ⇄ CalculationRecord (packages/contracts/src/scoring.ts). Цэвэр функцүүд (I/O-гүй).
import type { Calculation, Prisma } from '.prisma/client-scoring';
import type { CalcMethod, CalculationRecord, MethodVerdict, ScoreRequest, UnderwriteResult } from '@los/contracts';
import { underwrite } from '@los/calc';

const asJson = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/** `value` = бөөрөнхийлсөн харьцаа (ӨОХ бутархай / ӨТЧХ); `pass` нь бөөрөнхийлөөгүй утгаар шийдэгдсэн */
interface PolicyCheck { value: number | null; limit: number; pass: boolean }
const checkOf = (m: MethodVerdict): PolicyCheck => ({ value: m.ratio, limit: m.limit, pass: m.pass });

/**
 * `policy_check_json` (docs/03): `dti` = A арга (BR-1), `dscr` = B арга (BR-2), `dscrCombined` = C арга (BR-2, BR-5), `ltv` = BR-3.
 * Сонголтоос үл хамаарна — сонголт өөрчлөгдөхөд мөр хэвээр (зөвхөн selected_* баганууд шинэчлэгдэнэ).
 */
export function policyCheckOf(result: UnderwriteResult): { dti: PolicyCheck; dscr: PolicyCheck; dscrCombined: PolicyCheck; ltv: PolicyCheck } {
  const [a, b, c] = result.methods as [MethodVerdict, MethodVerdict, MethodVerdict];
  return { dti: checkOf(a), dscr: checkOf(b), dscrCombined: checkOf(c), ltv: { value: result.collateral.ltv, limit: result.collateral.limit, pass: result.collateral.pass } };
}

/** `stress_json` (FR-8.5): нийтлэг stress хураангуй + аргуудын үр дүн. stress өгөөгүй бол null */
export function stressJsonOf(result: UnderwriteResult): Prisma.InputJsonValue | undefined {
  if (!result.stress) return undefined;
  return asJson({ ...result.stress, outcomes: Object.fromEntries(result.methods.map((m) => [m.method, m.stress])) });
}

export interface NewCalculation {
  orgId: string;
  customerId: string;
  computedAt: Date;
  actorId: string | null;
  request: ScoreRequest;
  result: UnderwriteResult;
  /** Сонгогдсон арга (AUTO/MANUAL), байхгүй бол null */
  selection: { method: CalcMethod; manual: boolean; reason: string | null } | null;
}

/** `tx.calculation.create({ data })`. AUTO: selected_by = null; MANUAL: selected_by = хэрэглэгч */
export function toCreateData(n: NewCalculation): Prisma.CalculationUncheckedCreateInput {
  const [a, b, c] = n.result.methods;
  return {
    orgId: n.orgId,
    applicationId: n.request.applicationId,
    customerId: n.customerId,
    computedAt: n.computedAt,
    inputsJson: asJson(n.request),
    resultJson: asJson(n.result),
    methodAJson: asJson(a),
    methodBJson: asJson(b),
    methodCJson: asJson(c),
    autoSelectedMethod: n.result.autoSelected,
    selectedMethod: n.selection?.method ?? null,
    selectedBy: n.selection?.manual ? n.actorId : null,
    selectedReason: n.selection?.manual ? n.selection.reason : null,
    selectedAt: n.selection ? n.computedAt : null,
    policyCheckJson: asJson(policyCheckOf(n.result)),
    stressJson: stressJsonOf(n.result),
    createdBy: n.actorId,
    updatedBy: n.actorId,
  };
}

/** selected_by != null => MANUAL; selected_method байгаа бөгөөд selected_by null => AUTO */
export function selectionKindOf(row: Pick<Calculation, 'selectedMethod' | 'selectedBy'>): CalculationRecord['selection'] {
  if (!row.selectedMethod) return null;
  return row.selectedBy ? 'MANUAL' : 'AUTO';
}

/** `result_json` байхгүй мөр (гараар оруулсан/хуучин) → оролтоос дахин тооцно (цэвэр функц, нэг утга) */
export function resultOf(row: Pick<Calculation, 'resultJson' | 'inputsJson'>): UnderwriteResult {
  return (row.resultJson as UnderwriteResult | null) ?? underwrite(row.inputsJson as ScoreRequest);
}

export function toRecord(row: Calculation): CalculationRecord {
  return {
    id: row.id,
    applicationId: row.applicationId,
    customerId: row.customerId,
    computedAt: row.computedAt.toISOString(),
    isStale: row.isStale,
    staleReason: row.staleReason,
    selectedMethod: (row.selectedMethod as CalcMethod | null) ?? null,
    selection: selectionKindOf(row),
    selectedBy: row.selectedBy,
    selectedAt: row.selectedAt ? row.selectedAt.toISOString() : null,
    selectionReason: row.selectedReason,
    inputs: row.inputsJson as ScoreRequest,
    result: resultOf(row),
  };
}
