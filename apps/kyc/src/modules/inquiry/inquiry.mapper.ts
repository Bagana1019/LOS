import { InquiryRecord, UnregisteredLoan, type InquiryWarningLevel } from '@los/contracts';
import { decryptedField } from '@los/database';
import type { Inquiry, UnregisteredLoan as UnregisteredLoanRow } from '.prisma/client-kyc';

/** raw_json нь хувийн мэдээлэлтэй (зээлийн түүх, ял, өр) тул шифрлэгдэж хадгалагдана: `{ v: 1, enc: <ciphertext> }`. */
export const INQUIRY_RAW_AAD = 'kyc.inquiry.raw';

export function readDetail(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const enc = (raw as { enc?: unknown }).enc;
  if (typeof enc !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(decryptedField(enc, INQUIRY_RAW_AAD));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // гэмтсэн мөр лавлагааны жагсаалтыг унагахгүй
  }
}

export const toRecord = (row: Inquiry, withDetail = true): InquiryRecord =>
  InquiryRecord.parse({
    id: row.id,
    applicationId: row.applicationId,
    customerId: row.customerId,
    source: row.source,
    fetchedAt: row.fetchedAt.toISOString(),
    fetchedBy: row.fetchedBy,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    warningLevel: (row.warningLevel ?? 'NONE') as InquiryWarningLevel,
    summary: (row.summaryJson ?? {}) as Record<string, unknown>,
    detail: withDetail ? readDetail(row.rawJson) : null,
  });

export const toLoan = (row: UnregisteredLoanRow): UnregisteredLoan =>
  UnregisteredLoan.parse({ id: row.id, customerId: row.customerId, lenderName: row.lenderName, amount: Number(row.amount), monthlyPayment: Number(row.monthlyPayment), note: row.note });
