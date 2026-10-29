// Хариуны харагдцууд (REST controller дараагийн unit-д шууд буцаана). PII: регистр/данс/утас далдлагдсан; dedupe/statement hash-ийг гаргахгүй.
import type { BsaSummary } from '@los/contracts';
import type {
  BsaAnalysisRecord, BsaImportJobRecord, BsaTransactionRecord, ImportIssue,
} from '../common/persistence';
import { maskTail } from './masking';

export interface AnalysisCustomerView {
  registerNoMasked: string | null;
  lastName: string | null;
  firstName: string | null;
  phoneMasked: string | null;
  gender: string | null;
  note: string | null;
  declaredAccounts: Array<{ bankCode: string | null; accountMasked: string | null; ibanMasked: string | null; holderName: string | null; source: 'MANUAL' | 'STATEMENT' }>;
}

export interface AnalysisView {
  id: string;
  applicationId: string;
  customerId: string;
  borrowerId: string | null;
  branchId: string | null;
  status: BsaAnalysisRecord['status'];
  version: number;
  periodFrom: string | null;
  periodTo: string | null;
  periodMonths: number | null;
  proposedMonthlyPayment: number | null;
  costOfGoodsRate: number | null;
  summary: BsaSummary | null;
  customer: AnalysisCustomerView | null;
  ownAccountCount: number;
  analyzedAt: Date | null;
  pushedToLosAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}

export function toAnalysisView(a: BsaAnalysisRecord): AnalysisView {
  const c = a.customer;
  return {
    id: a.id,
    applicationId: a.applicationId,
    customerId: a.customerId,
    borrowerId: a.borrowerId,
    branchId: a.branchId,
    status: a.status,
    version: a.version,
    periodFrom: a.periodFrom,
    periodTo: a.periodTo,
    periodMonths: a.periodMonths,
    proposedMonthlyPayment: a.proposedMonthlyPayment,
    costOfGoodsRate: a.costOfGoodsRate,
    summary: a.summary,
    customer: c
      ? {
          registerNoMasked: maskTail(c.registerNo),
          lastName: c.lastName,
          firstName: c.firstName,
          phoneMasked: maskTail(c.phone),
          gender: c.gender,
          note: c.note,
          declaredAccounts: c.declaredAccounts.map((d) => ({
            bankCode: d.bankCode,
            accountMasked: maskTail(d.accountNo),
            ibanMasked: maskTail(d.iban),
            holderName: d.holderName,
            source: d.source,
          })),
        }
      : null,
    ownAccountCount: a.ownAccounts.length,
    analyzedAt: a.analyzedAt,
    pushedToLosAt: a.pushedToLosAt,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    createdBy: a.createdBy,
  };
}

export interface ImportJobView {
  id: string;
  analysisId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  bankCode: string | null;
  format: BsaImportJobRecord['format'];
  accountMasked: string | null;
  ibanMasked: string | null;
  holderName: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  status: BsaImportJobRecord['status'];
  rowsTotal: number;
  rowsDone: number;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  parserOk: boolean | null;
  verifierOk: boolean | null;
  qrVerified: boolean | null;
  attempts: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export function toJobView(j: BsaImportJobRecord): ImportJobView {
  return {
    id: j.id,
    analysisId: j.analysisId,
    fileName: j.fileName,
    mimeType: j.mimeType,
    sizeBytes: j.sizeBytes,
    bankCode: j.bankCode,
    format: j.format,
    accountMasked: maskTail(j.accountNo),
    ibanMasked: maskTail(j.iban),
    holderName: j.holderName,
    periodFrom: j.periodFrom,
    periodTo: j.periodTo,
    status: j.status,
    rowsTotal: j.rowsTotal,
    rowsDone: j.rowsDone,
    errors: j.errors,
    warnings: j.warnings,
    parserOk: j.parserOk,
    verifierOk: j.verifierOk,
    qrVerified: j.qrVerified,
    attempts: j.attempts,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    createdAt: j.createdAt,
  };
}

export type TransactionView = Omit<BsaTransactionRecord, 'statementKey' | 'dedupeKey'>;

/** Дотоод hash түлхүүрийг гаргахгүй; харьцсан дансны дугаарыг далдална (сүүлийн 4 цифр). Утга/нэр нь ангилал шалгахад хэрэгтэй тул хэвээр */
export function toTransactionView(t: BsaTransactionRecord): TransactionView {
  const { statementKey: _s, dedupeKey: _d, ...rest } = t;
  return { ...rest, counterpartyAccount: maskTail(t.counterpartyAccount) };
}
