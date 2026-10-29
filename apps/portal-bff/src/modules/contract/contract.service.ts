import { Inject, Injectable } from '@nestjs/common';
import type { PortalContractInfo } from '@los/contracts';
import { AuditService } from '../../audit/audit.service';
import type { CallContext } from '../../common/request-context';
import { CONTRACT_FILES, type ContractDownload, type ContractFilesPort } from '../../integrations/contract-files/contract-files.port';
import { LoanOwnershipService, ensureSameLoan } from '../loans/loan-ownership.service';

@Injectable()
export class ContractService {
  constructor(
    @Inject(CONTRACT_FILES) private readonly files: ContractFilesPort,
    private readonly ownership: LoanOwnershipService,
    private readonly audit: AuditService,
  ) {}

  async info(ctx: CallContext, loanId: string): Promise<PortalContractInfo> {
    await this.ownership.assertOwned(ctx, loanId);
    const info = await this.files.getInfo(ctx, loanId);
    ensureSameLoan(loanId, info.loanId);
    return info;
  }

  /** Гэрээний PDF татах. Эрх шалгасны дараа л файл нээж, амжилттай нээгдсэн үед аудитад бичнэ. */
  async download(ctx: CallContext, loanId: string): Promise<ContractDownload> {
    await this.ownership.assertOwned(ctx, loanId);
    const download = await this.files.open(ctx, loanId);
    try {
      ensureSameLoan(loanId, download.info.loanId);
    } catch (err) {
      download.stream.destroy();
      throw err;
    }
    await this.audit.record({
      action: 'CONTRACT_DOWNLOADED',
      correlationId: ctx.correlationId,
      outcome: 'SUCCESS',
      customerId: ctx.customerId,
      target: { type: 'LOAN', id: loanId },
      meta: { signed: download.info.signed },
    });
    return download;
  }

  /** Урсгал дундаа тасарсан (эх үүсвэр эсвэл клиент) — «амжилттай татсан» гэж андуурахгүйн тулд тусад нь тэмдэглэнэ. */
  recordAborted(ctx: CallContext, loanId: string): Promise<void> {
    return this.audit.record({
      action: 'CONTRACT_DOWNLOAD_ABORTED',
      correlationId: ctx.correlationId,
      outcome: 'FAILURE',
      customerId: ctx.customerId,
      target: { type: 'LOAN', id: loanId },
    });
  }
}
