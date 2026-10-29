import type { Readable } from 'node:stream';
import type { PortalContractInfo } from '@los/contracts';
import type { CallContext } from '../../common/request-context';

export const CONTRACT_FILES = Symbol('CONTRACT_FILES');

export interface ContractDownload {
  info: PortalContractInfo;
  stream: Readable;
  /** Эх үүсвэрийн зарласан хэмжээ (байт). Мэдэгдэж байвал клиентэд Content-Length болгож, дутуу татагдсаныг илрүүлнэ. */
  contentLength?: number;
}

/**
 * Гэрээний PDF. origination (contract meta) эзэмшинэ, файлыг dms-ээс авна (origination → dms sync, CLAUDE.md §3.2-2).
 * Гарын үсэгтэй хувилбар байвал түүнийг, үгүй бол үүсгэсэн хувилбарыг өгнө.
 */
export interface ContractFilesPort {
  getInfo(ctx: CallContext, loanId: string): Promise<PortalContractInfo>;
  open(ctx: CallContext, loanId: string): Promise<ContractDownload>;
}
