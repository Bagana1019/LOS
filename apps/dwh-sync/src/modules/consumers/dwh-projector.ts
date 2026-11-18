// Validate → idempotent apply. Skips (unknown version, invalid, unmapped type) are logged and acknowledged — they never throw.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DWH_DATABASE, type DwhDatabase } from '../etl/dwh-database';
import { applyToDwh } from '../etl/fact-writers';
import { consumeOnceInDwh } from './consume-once';
import { decodeDwhEvent } from './decode';

export type ProjectionOutcome = 'APPLIED' | 'DUPLICATE' | 'SKIPPED';

/** Log-safe identity of a raw message: eventId / type / version only (no payload → no PII in logs, CLAUDE.md §6.5). */
const identity = (raw: unknown) => {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : undefined);
  return { eventId: str(r.eventId), type: str(r.type), version: typeof r.version === 'number' ? r.version : undefined };
};

@Injectable()
export class DwhProjector {
  private readonly log = new Logger('DwhProjector');
  constructor(@Inject(DWH_DATABASE) private readonly db: DwhDatabase) {}

  async handle(consumer: string, raw: unknown): Promise<ProjectionOutcome> {
    const decoded = decodeDwhEvent(raw);
    if (!decoded.ok) {
      this.log.warn(JSON.stringify({ msg: 'dwh event skipped', consumer, reason: decoded.reason, ...identity(raw) }));
      return 'SKIPPED';
    }
    const applied = await consumeOnceInDwh(this.db, consumer, decoded.event.eventId, (c) => applyToDwh(c, decoded.event));
    return applied ? 'APPLIED' : 'DUPLICATE';
  }
}
