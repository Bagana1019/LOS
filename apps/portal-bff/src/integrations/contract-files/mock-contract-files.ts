import { Readable } from 'node:stream';
import type { CallContext } from '../../common/request-context';
import type { MockLedger } from '../mock/mock-ledger';
import type { ContractDownload, ContractFilesPort } from './contract-files.port';

export class MockContractFiles implements ContractFilesPort {
  constructor(private readonly ledger: MockLedger) {}

  async getInfo(ctx: CallContext, loanId: string) {
    return this.ledger.contractInfo(ctx.customerId, loanId);
  }

  async open(ctx: CallContext, loanId: string): Promise<ContractDownload> {
    const info = this.ledger.contractInfo(ctx.customerId, loanId);
    return { info, stream: Readable.from([this.ledger.contractPdf(ctx.customerId, loanId)]) };
  }
}
