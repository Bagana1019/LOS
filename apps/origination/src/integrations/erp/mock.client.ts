import { createHash } from 'node:crypto';
import type { ErpEventPayload } from '@los/contracts';
import { ErpPostError, type ErpGateway, type ErpPostContext, type ErpPostResult } from './erp.interface';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// Deterministic mock: ижил idempotencyKey -> ижил external ref. Санах ойд хадгална (dev/test).
export class MockErpClient implements ErpGateway {
  readonly name = 'mock';
  private readonly posted = new Map<string, { contentHash: string; externalRef: string }>();
  private script: Array<ErpPostError | null> = [];

  async post(payload: ErpEventPayload, _ctx: ErpPostContext): Promise<ErpPostResult> {
    const scripted = this.script.shift();
    if (scripted) throw scripted;
    // eventId/createdAt/correlationId нь дахин илгээлтэд өөрчлөгдөхгүй ч, агуулгын харьцуулалтад зөвхөн бизнес талбарыг авна
    const contentHash = sha(JSON.stringify([payload.eventType, payload.currency, payload.businessDate, payload.data]));
    const existing = this.posted.get(payload.idempotencyKey);
    if (existing) {
      if (existing.contentHash !== contentHash) throw new ErpPostError('idempotency key reused with different content', 'PERMANENT', 'IDEMPOTENCY_CONFLICT', 409);
      return { externalRef: existing.externalRef, duplicate: true };
    }
    const externalRef = `MOCK-${sha(payload.idempotencyKey).slice(0, 12).toUpperCase()}`;
    this.posted.set(payload.idempotencyKey, { contentHash, externalRef });
    return { externalRef, duplicate: false };
  }

  // Туршилт/dev: дараагийн дуудлагуудын үр дүнг тогтоно (null = амжилттай)
  scriptResults(results: Array<ErpPostError | null>): void { this.script = [...results]; }
  get postedKeys(): string[] { return [...this.posted.keys()]; }
}
