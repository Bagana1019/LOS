import type { BorrowerCandidate, BorrowerCustomerView, BorrowerRole, BorrowerView, CustomerType, BorrowerRelation, GuaranteeType } from '@los/contracts';
import type { Customer, Prisma } from '.prisma/client-origination';
import { ROLE_ORDER, type BorrowerRow } from './borrower.rules';
import { customerDisplayName, customerRegisterNoMasked } from './customer-directory';

export type BorrowerWithCustomer = Prisma.LoanApplicationBorrowerGetPayload<{ include: { customer: true } }>;

const num = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));

/** Үндсэн → хамтран → батлан даагч → барьцаалагч, дараа нь нэмсэн дарааллаар. */
export const sortBorrowers = <T extends { role: string; createdAt: Date; id: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => ROLE_ORDER[a.role as BorrowerRole] - ROLE_ORDER[b.role as BorrowerRole] || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

/** Prisma мөр → дүрмийн цэвэр функцүүдийн оролт. */
export function toRow(b: BorrowerWithCustomer): BorrowerRow {
  return {
    id: b.id, customerId: b.customerId, role: b.role as BorrowerRole, isPrimary: b.isPrimary,
    relationToPrimary: b.relationToPrimary as BorrowerRelation | null,
    liabilityShare: num(b.liabilityShare), guaranteeType: b.guaranteeType as GuaranteeType | null, guaranteeAmount: num(b.guaranteeAmount),
    incomeIncluded: b.incomeIncluded, note: b.note, consentSignedAt: b.consentSignedAt,
    customer: { displayName: customerDisplayName(b.customer), customerType: b.customer.customerType as CustomerType, isPep: b.customer.isPep, isRelatedParty: b.customer.isRelatedParty },
  };
}

/** NFR-5: бүтэн регистр API-д гарахгүй — зөвхөн нуугдмал хэлбэр. */
export function toCustomerView(c: Customer): BorrowerCustomerView {
  return {
    id: c.id, customerType: c.customerType as CustomerType, displayName: customerDisplayName(c), registerNoMasked: customerRegisterNoMasked(c),
    phone: c.phone, email: c.email, isPep: c.isPep, isRelatedParty: c.isRelatedParty,
  };
}

export function toBorrowerView(b: BorrowerWithCustomer): BorrowerView {
  return {
    id: b.id, applicationId: b.applicationId, customerId: b.customerId, role: b.role as BorrowerRole, isPrimary: b.isPrimary,
    relationToPrimary: b.relationToPrimary as BorrowerRelation | null,
    liabilityShare: num(b.liabilityShare), guaranteeType: b.guaranteeType as GuaranteeType | null, guaranteeAmount: num(b.guaranteeAmount),
    consentFileId: b.consentFileId, consentSignedAt: b.consentSignedAt?.toISOString() ?? null,
    incomeIncluded: b.incomeIncluded, note: b.note,
    customer: toCustomerView(b.customer), createdAt: b.createdAt.toISOString(),
  };
}

export function toCandidate(c: Customer, linkedRoles: BorrowerRole[]): BorrowerCandidate {
  return {
    customerId: c.id, displayName: customerDisplayName(c), registerNoMasked: customerRegisterNoMasked(c),
    customerType: c.customerType as CustomerType, phone: c.phone,
    linkedRoles: [...linkedRoles].sort((a, b) => ROLE_ORDER[a] - ROLE_ORDER[b]),
  };
}
