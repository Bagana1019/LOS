import { createHash } from 'node:crypto';
import { ErpEventPayload } from '@los/contracts';
import type { ErpEventRecord } from './erp-event.repository';
import type { ErpEventHeader } from './event-plan';
import type { ErpEventData } from '@los/contracts';

// Идэмпотент давталтыг танихад хэрэгтэй эдийн засгийн мөн чанар: бизнесийн огноо, memo, correlationId-г оруулахгүй
// (давтан дуудалт өөр өдөр хийгдсэн ч үйл явдал нэг хэвээр).
export function contentHashOf(eventType: string, sourceId: string, h: ErpEventHeader, data: ErpEventData): string {
  const econ = 'fees' in data ? { fees: data.fees.map((f) => [f.kind, f.amount]), totalAmount: data.totalAmount } : data;
  const canon = [eventType, sourceId, h.applicationId, h.currency, Object.entries(econ).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))];
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

export type PayloadSource = Pick<ErpEventRecord,
  'id' | 'idempotencyKey' | 'eventType' | 'orgId' | 'branchId' | 'applicationId' | 'contractNo' | 'coreLoanId' | 'customerId' |
  'businessDate' | 'currency' | 'correlationId' | 'createdAt' | 'data'>;

// Гадаад системд явах түлхүүр org-оор нэрлэгдэнэ: DB-н unique нь (org_id, key) тул өөр байгууллагын ижил sourceId давхцахгүй
export const wireIdempotencyKey = (orgId: string, idempotencyKey: string) => `${orgId}:${idempotencyKey}`;

// outbox мөр -> гадаад системд явах payload. Оролдлого бүрт ижил, тогтвортой. Зөрчилтэй бол ZodError.
export function buildErpPayload(e: PayloadSource): ErpEventPayload {
  return ErpEventPayload.parse({
    schemaVersion: 1, eventId: e.id, idempotencyKey: wireIdempotencyKey(e.orgId, e.idempotencyKey), eventType: e.eventType,
    orgId: e.orgId, branchId: e.branchId, applicationId: e.applicationId, contractNo: e.contractNo, coreLoanId: e.coreLoanId, customerId: e.customerId,
    businessDate: e.businessDate, currency: e.currency, data: e.data, correlationId: e.correlationId, createdAt: e.createdAt.toISOString(),
  });
}
