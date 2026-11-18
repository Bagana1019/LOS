import { randomUUID } from 'node:crypto';
import type { AmlScreeningResult, AmlScreenRequest, RequestContext, ScreeningStatus } from '@los/contracts';
import type { z } from 'zod';
import { amlUnavailable, type KycAmlPort } from '../ports/kyc-aml.port';

// Тестийн kyc AML: харилцагч тутамд сүүлийн шалгалт (kyc-ийн «одоогийнх» дүрэм — docs/05-compliance-aml.md §5). Deterministic: үр дүнг тест тохируулна (анхдагч CLEAR).
type Op = 'screen' | 'latest';
interface Outcome { status: ScreeningStatus; blocking: boolean }

const BLOCKING: ReadonlySet<ScreeningStatus> = new Set(['REVIEW_REQUIRED', 'CONFIRMED_MATCH']);

export class FakeKycAml implements KycAmlPort {
  readonly calls: { op: Op; customerId: string; ctx: RequestContext; req?: z.input<typeof AmlScreenRequest> }[] = [];
  /** `true` бол бүх дуудлага 503 `AML_SCREENING_UNAVAILABLE` (kyc унасан). */
  down = false;
  /** `screen` хариу буцаахаас ӨМНӨ (kyc дуудлагын явц) — зэрэг засварыг дуурайна. */
  onScreen?: (customerId: string) => Promise<void>;
  private readonly latestByCustomer = new Map<string, AmlScreeningResult>();
  private readonly outcomes = new Map<string, Outcome>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  reset(): void {
    this.calls.length = 0;
    this.down = false;
    this.onScreen = undefined;
    this.latestByCustomer.clear();
    this.outcomes.clear();
  }

  /** Дараагийн `screen`-ийн үр дүн (харилцагчаар). */
  willScreen(customerId: string, status: ScreeningStatus): void {
    this.outcomes.set(customerId, { status, blocking: BLOCKING.has(status) });
  }

  /** kyc-д өмнө нь хийгдсэн шалгалт (жнь ЗЭЗ «Лавлагаа» алхамд). */
  seedLatest(customerId: string, o: Partial<AmlScreeningResult> = {}): AmlScreeningResult {
    const status = o.status ?? 'CLEAR';
    const r = this.result(customerId, null, { status, blocking: BLOCKING.has(status) }, o);
    this.latestByCustomer.set(customerId, r);
    return r;
  }

  /** Комплаенс hit-ийг шийдвэрлэсэн (ижил screening id, төлөв шинэчлэгдэнэ — kyc `POST /aml/hits/:id/review`). */
  review(customerId: string, status: 'CLEARED_AFTER_REVIEW' | 'CONFIRMED_MATCH'): AmlScreeningResult {
    const cur = this.latestByCustomer.get(customerId);
    if (!cur) throw new Error(`no screening for ${customerId}`);
    const next = { ...cur, status, blocking: status === 'CONFIRMED_MATCH' };
    this.latestByCustomer.set(customerId, next);
    return next;
  }

  screenCalls(): string[] { return this.calls.filter((c) => c.op === 'screen').map((c) => c.customerId); }

  async screen(ctx: RequestContext, req: z.input<typeof AmlScreenRequest>): Promise<AmlScreeningResult> {
    this.calls.push({ op: 'screen', customerId: req.customerId, ctx, req });
    if (this.down) throw amlUnavailable();
    const outcome = this.outcomes.get(req.customerId) ?? { status: 'CLEAR', blocking: false };
    const r = this.result(req.customerId, req.applicationId ?? null, outcome, { screenedBy: ctx.userId });
    await this.onScreen?.(req.customerId);
    this.latestByCustomer.set(req.customerId, r);
    return r;
  }

  async latest(ctx: RequestContext, customerId: string): Promise<AmlScreeningResult | null> {
    this.calls.push({ op: 'latest', customerId, ctx });
    if (this.down) throw amlUnavailable();
    return this.latestByCustomer.get(customerId) ?? null;
  }

  private result(customerId: string, applicationId: string | null, outcome: Outcome, o: Partial<AmlScreeningResult>): AmlScreeningResult {
    const base: AmlScreeningResult = {
      id: randomUUID(), orgId: 'org-test', customerId, applicationId, trigger: 'APPLICATION', status: outcome.status, blocking: outcome.blocking,
      riskScore: outcome.blocking ? 60 : 0, riskLevel: outcome.blocking ? 'HIGH' : 'LOW', riskFactors: [], subjectName: 'Тест', registerNoMasked: 'УБ******00',
      hits: [], listVersions: { UN_SC: 'fixture-2026-10', FATF: 'fixture-2026-10', INTERNAL_BLACKLIST: 'live' }, screenedAt: this.now().toISOString(), screenedBy: null,
    };
    return { ...base, ...o };
  }
}
