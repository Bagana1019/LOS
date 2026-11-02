import { CalcMethodCode, SoscoGrade, type CalcMethod, type CalculationRecord, type SoscoScoreResponse, type SoscoSummary } from '@los/contracts';

/** FR-10.4: тооцоолол, сонголтыг зөвхөн "Шинэ" (DRAFT) ба "Буцаасан" (RETURNED) хүсэлтэд хийнэ. */
export const EDITABLE_STATUSES = ['DRAFT', 'RETURNED'] as const;
export const isEditableStatus = (status: string): boolean => (EDITABLE_STATUSES as readonly string[]).includes(status);

/**
 * `loan_application.calc_snapshot_json` — wizard-ын хураангуй/жагсаалтад харуулах товч (бүтэн үр дүн scoring-д). Хувийн мэдээлэл агуулахгүй.
 * `syncedAt` нь scoring-ийн сүүлчийн үйл явдлын (тооцоолол/сонголт) цаг: хоцорч ирсэн хуучин `ScoringCompleted` шинэ төлөвийг дарахаас хамгаална.
 */
export interface CalcSnapshot {
  /** Scoring-ийн `calculation.id`; event-ээс засварласан бөгөөд мөр тодорхойгүй бол null */
  calculationId: string | null;
  selectedMethod: CalcMethod | null;
  selection: 'AUTO' | 'MANUAL' | null;
  ratioKind: 'DTI' | 'DSCR' | null;
  /** Сонгосон аргын харьцаа / хязгаар / хангасан эсэх (FR-8.4) */
  ratio: number | null;
  limit: number | null;
  pass: boolean | null;
  eligible: boolean | null;
  ltv: number | null;
  soscoScore: number | null;
  soscoGrade: SoscoGrade | null;
  computedAt: string;
  syncedAt: string;
  /** `ScoringCompleted`-ээр засварласан (ratio/pass зэрэг дэлгэрэнгүйг scoring-аас дахин уншиж харуулна) */
  reconciled?: true;
}

export interface SoscoFacts { score: number | null; grade: SoscoGrade | null }

/** Хоёр ISO цагийн хожим нь (миллисекундийн оронгоос үл хамаарч Date-ээр харьцуулна). */
export const laterOf = (a: string | null, b: string | null): string => {
  const times = [a, b].filter((x): x is string => !!x);
  return times.reduce((best, t) => (Date.parse(t) > Date.parse(best) ? t : best), times[0] ?? new Date(0).toISOString());
};

/** Тооцооллын мөр → товч. `sosco` = Sosco-ийн оноо/зэрэг (INSUFFICIENT_DATA эсвэл байхгүй бол null). */
export function buildSnapshot(record: CalculationRecord, sosco: SoscoFacts | null): CalcSnapshot {
  const verdict = record.selectedMethod ? record.result.methods.find((m) => m.method === record.selectedMethod) : undefined;
  return {
    calculationId: record.id,
    selectedMethod: record.selectedMethod,
    selection: record.selection,
    ratioKind: verdict?.ratioKind ?? null,
    ratio: verdict?.ratio ?? null,
    limit: verdict?.limit ?? null,
    pass: verdict?.pass ?? null,
    eligible: verdict?.eligible ?? null,
    ltv: record.result.collateral.ltv,
    soscoScore: sosco?.score ?? null,
    soscoGrade: sosco?.grade ?? null,
    computedAt: record.computedAt,
    syncedAt: laterOf(record.computedAt, record.selectedAt),
  };
}

/** JSON-ийн муу хэлбэрийг (гараар засагдсан, хуучин) үл тоож зөвхөн мэдэгдэх талбарыг уншина. */
export function readSnapshot(json: unknown): CalcSnapshot | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const method = CalcMethodCode.safeParse(o.selectedMethod);
  const grade = SoscoGrade.safeParse(o.soscoGrade);
  const str = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const computedAt = str(o.computedAt);
  if (!computedAt) return null;
  return {
    calculationId: typeof o.calculationId === 'string' ? o.calculationId : null,
    selectedMethod: method.success ? method.data : null,
    selection: o.selection === 'AUTO' || o.selection === 'MANUAL' ? o.selection : null,
    ratioKind: o.ratioKind === 'DTI' || o.ratioKind === 'DSCR' ? o.ratioKind : null,
    ratio: num(o.ratio), limit: num(o.limit),
    pass: typeof o.pass === 'boolean' ? o.pass : null,
    eligible: typeof o.eligible === 'boolean' ? o.eligible : null,
    ltv: num(o.ltv), soscoScore: num(o.soscoScore), soscoGrade: grade.success ? grade.data : null,
    computedAt, syncedAt: str(o.syncedAt) ?? computedAt,
    ...(o.reconciled === true ? { reconciled: true as const } : {}),
  };
}

/** `ScoringCompleted`-ээр засварлах: сонгосон арга солигдсон бол арга-тусгай дэлгэрэнгүйг (ratio, pass…) хүчингүй болгоно. */
export function reconcileSnapshot(existing: CalcSnapshot | null, event: { selectedMethod: CalcMethod; soscoScore: number | null; occurredAt: string }): CalcSnapshot {
  const same = existing?.selectedMethod === event.selectedMethod;
  return {
    calculationId: existing?.calculationId ?? null,
    selectedMethod: event.selectedMethod,
    selection: same ? existing!.selection : null,
    ratioKind: same ? existing!.ratioKind : null,
    ratio: same ? existing!.ratio : null,
    limit: same ? existing!.limit : null,
    pass: same ? existing!.pass : null,
    eligible: same ? existing!.eligible : null,
    ltv: existing?.ltv ?? null,
    soscoScore: event.soscoScore,
    soscoGrade: event.soscoScore !== null && existing?.soscoScore === event.soscoScore ? existing.soscoGrade : null,
    computedAt: existing?.computedAt ?? event.occurredAt,
    syncedAt: event.occurredAt,
    reconciled: true,
  };
}

export interface StepRow { id: string; status: string }
export type StepPlan =
  | { kind: 'skip' }
  | { kind: 'create'; status: 'COMPLETED' | 'PENDING'; completedAt: Date | null }
  | { kind: 'update'; id: string; status: 'COMPLETED' | 'PENDING'; completedAt: Date | null };

/** Алхам `score`: арга сонгогдсон бол COMPLETED (completed_at = одоо), үгүй бол PENDING; LOCKED мөрийг хөндөхгүй; мөр байхгүй бол үүсгэнэ. */
export function planScoreStep(step: StepRow | null, selectedMethod: string | null, now: Date): StepPlan {
  if (step?.status === 'LOCKED') return { kind: 'skip' };
  const status = selectedMethod ? 'COMPLETED' : 'PENDING';
  const completedAt = selectedMethod ? now : null;
  return step ? { kind: 'update', id: step.id, status, completedAt } : { kind: 'create', status, completedAt };
}

/**
 * `markStale` scoring-д хүрэхгүй байсан ч алхам STALE байвал тооцоолол хуучирсан гэж харуулна (алхам нь эцсийн эх сурвалж).
 * Тооцоолол алхмыг хуучруулсны ДАРАА хийгдсэн бол (шинэ) хэвээр.
 */
export function overlayStale(record: CalculationRecord | null, step: { status: string; staleReason: string | null; updatedAt: Date } | null): CalculationRecord | null {
  if (!record || record.isStale || !step || step.status !== 'STALE') return record;
  if (Date.parse(record.computedAt) > step.updatedAt.getTime()) return record;
  return { ...record, isStale: true, staleReason: step.staleReason ?? record.staleReason };
}

export function toSoscoSummary(r: SoscoScoreResponse, customerId: string): SoscoSummary {
  return {
    resultId: r.resultId, customerId, status: r.status, score: r.score, grade: r.grade, coverage: r.coverage, components: r.components, modelVersion: r.modelVersion, computedAt: r.computedAt,
  };
}
