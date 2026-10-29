import type { PosScreeningRequest, PosScreeningResponse } from '@los/contracts';
import { DomainError } from '../domain/errors';
import { MockBuyerScreening } from '../integrations/screening/mock-buyer-screening';
import { BuyerScreeningPort, Clock, type ScreeningContext } from '../ports';

/** Тестэд: mock лавлагааг дуудлага тоолдог, гэмтэл (outage) дуурайдаг боломжтой болгосон. */
export class ControllableScreening extends BuyerScreeningPort {
  readonly calls: PosScreeningRequest[] = [];
  /** `calls`-тай индексээрээ таарна: дуудагчийн дамжуулсан tenant context (байхгүй бол undefined) */
  readonly contexts: Array<ScreeningContext | undefined> = [];
  failing = false;
  private readonly inner: MockBuyerScreening;
  constructor(clock: Clock) {
    super();
    this.inner = new MockBuyerScreening(clock);
  }
  async screen(req: PosScreeningRequest, correlationId: string, context?: ScreeningContext): Promise<PosScreeningResponse> {
    this.calls.push(req);
    this.contexts.push(context);
    if (this.failing) throw new DomainError('SCREENING_UNAVAILABLE', 'Credit screening is temporarily unavailable');
    void correlationId;
    return this.inner.screen(req);
  }
}
