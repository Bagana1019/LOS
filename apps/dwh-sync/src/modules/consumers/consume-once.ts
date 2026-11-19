// CLAUDE.md §3.2.6 for the DWH: the processed_events marker and the fact writes commit in ONE DWH transaction.
// (@los/database consumeOnce is Prisma-specific; the DWH is plain pg.) A concurrent duplicate blocks on the PK, then sees the row → skipped.
import type { DwhClient, DwhDatabase } from '../etl/dwh-database';

/** `true` = applied now; `false` = this consumer already processed `eventId` (nothing written). Throw → marker rolled back, bus redelivers. */
export async function consumeOnceInDwh(db: DwhDatabase, consumer: string, eventId: string, fn: (c: DwhClient) => Promise<void>): Promise<boolean> {
  return db.transaction(async (c) => {
    const marker = await c.query('INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [consumer, eventId]);
    if (marker.rowCount === 0) return false;
    await fn(c);
    return true;
  });
}
