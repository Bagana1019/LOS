import { z } from 'zod';
import { BankTransferInstruction, PaymentDeeplink, PaymentInvoiceView, PaymentView } from '@los/contracts';
import type { PaymentInvoice } from '.prisma/client-origination';
import type { Prisma } from '.prisma/client-origination';

export const num = (d: { toString(): string } | number | null | undefined): number => (d == null ? 0 : Number(d));
/** Prisma @db.Date (UTC 00:00) → YYYY-MM-DD. */
export const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

export const PAYMENT_INCLUDE = { allocations: { include: { row: { select: { seq: true, dueDate: true } } } } } satisfies Prisma.PaymentInclude;
export type PaymentWithAllocations = Prisma.PaymentGetPayload<{ include: typeof PAYMENT_INCLUDE }>;

export function toPaymentView(p: PaymentWithAllocations): PaymentView {
  return PaymentView.parse({
    id: p.id, applicationId: p.applicationId, invoiceId: p.invoiceId, provider: p.provider, providerPaymentId: p.providerPaymentId,
    amount: num(p.amount), currency: p.currency, paidAt: p.paidAt.toISOString(), unallocatedAmount: num(p.unallocatedAmount), payerAccountMasked: p.payerAccountMasked,
    allocations: [...p.allocations].sort((a, b) => a.row.seq - b.row.seq).map((a) => ({
      scheduleRowId: a.scheduleRowId, seq: a.row.seq, dueDate: dateOnly(a.row.dueDate), interestPaid: num(a.interestPaid), principalPaid: num(a.principalPaid), totalPaid: num(a.totalPaid),
    })),
  });
}

const Deeplinks = z.array(PaymentDeeplink).catch([]);
const Instruction = BankTransferInstruction.nullable().catch(null);

export function toInvoiceView(i: PaymentInvoice): PaymentInvoiceView {
  return PaymentInvoiceView.parse({
    id: i.id, applicationId: i.applicationId, provider: i.provider, status: i.status, amount: num(i.amount), currency: i.currency, scheduleRowId: i.scheduleRowId,
    senderInvoiceNo: i.senderInvoiceNo, expiresAt: i.expiresAt.toISOString(), paidAt: i.paidAt ? i.paidAt.toISOString() : null,
    qrText: i.qrText, qrImage: i.qrImage, deeplinks: Deeplinks.parse(i.deeplinksJson ?? []), bankTransfer: Instruction.parse(i.bankTransferJson ?? null), createdAt: i.createdAt.toISOString(),
  });
}
