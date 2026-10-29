import type { IntegrationMode } from '@los/contracts';

// FR-12.4 (нэр-дугаар тулгалт), эргэн төлөлтийн банкны шилжүүлгийн тулгалт, олголтын payout. Банк тус бүрийн corporate gateway-г ардаа нууна.
export interface NameCheckRequest { bankCode: string; accountNo: string; holderName: string }
export interface NameCheckResult { matched: boolean; registeredName: string | null; similarity: number }

export interface ListIncomingRequest { since: Date; accountNo: string }
export interface IncomingTransfer {
  bankCode: string;
  /** Банкны гүйлгээний дугаар — (bankCode, bankReference) давтагдашгүй. */
  bankReference: string;
  /** Манай хүлээн авсан данс. */
  accountNo: string;
  amount: number;
  currency: string;
  valueDate: Date;
  /** Гүйлгээний утга (senderInvoiceNo / гэрээний дугаар агуулна). */
  description: string;
  payerName: string | null;
  /** Бүтэн дансны дугаар байж болно — хадгалахдаа заавал нуугдмал болгоно. */
  payerAccount: string | null;
}

export interface TransferRequest {
  fromAccountNo: string; toBankCode: string; toAccountNo: string; toHolderName: string;
  amount: number; currency: string; description: string;
  /** Давтагдашгүй түлхүүр — ижил reference-тэй дахин дуудахад давхар шилжүүлэхгүй. */
  reference: string;
}
export interface TransferResult { bankReference: string; status: 'COMPLETED'; executedAt: Date }

export interface BankGatewayPort {
  readonly mode: IntegrationMode;
  isAvailable(): boolean;
  unavailableReason(): 'NOT_CONFIGURED' | 'NOT_IMPLEMENTED' | null;
  nameCheck(req: NameCheckRequest): Promise<NameCheckResult>;
  listIncomingTransfers(req: ListIncomingRequest): Promise<IncomingTransfer[]>;
  /** Олголтын payout. Одоогоор ашиглагдахгүй (Core-н үүрэг), интерфейст байлгасан. */
  transfer(req: TransferRequest): Promise<TransferResult>;
}
