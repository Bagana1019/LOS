import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { PortalContractInfo, type RequestContext } from '@los/contracts';
import { InternalHttpClient } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { portalError } from './portal-errors';
import { PortalLoansService } from './portal-loans.service';

/** origination → dms (CLAUDE.md §3.2.2): гэрээний PDF-ийн байт. dms харилцагчийн эрх мэдэхгүй — эзэмшлийг ЭНД шалгасны дараа л дуудна. */
export interface PortalContractFilesPort {
  fetchPdf(ctx: RequestContext, fileId: string): Promise<Buffer>;
}
export const PORTAL_CONTRACT_FILES = Symbol('PORTAL_CONTRACT_FILES');

const DMS_FILE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 26_214_400; // docs/05 §7 PORTAL_MAX_CONTRACT_BYTES (25 MiB)
const PDF_MAGIC = Buffer.from('%PDF-');

/** dms руу харилцагчийн нэрээр биш, origination-ий сервисийн нэрээр хандана (эзэмшлийг өмнө нь шалгасан; dms харилцагчийн контекстыг хаадаг). */
export const PORTAL_DMS_SERVICE_USER = 'svc:origination-portal';

export class HttpDmsContractFiles implements PortalContractFilesPort {
  constructor(private readonly http = new InternalHttpClient()) {}
  async fetchPdf(ctx: RequestContext, fileId: string): Promise<Buffer> {
    const serviceCtx: RequestContext = { userId: PORTAL_DMS_SERVICE_USER, roles: [], branchId: null, orgId: ctx.orgId, customerId: null, correlationId: ctx.correlationId };
    return this.http.get<Buffer>('dms', `/api/files/${encodeURIComponent(fileId)}/content`, { ctx: serviceCtx, responseType: 'buffer', timeoutMs: DMS_FILE_TIMEOUT_MS });
  }
}

export interface ContractPdf { info: PortalContractInfo; pdf: Buffer }

/** PRT-FR-4.1: гарын үсэгтэй хувилбар байвал түүнийг, үгүй бол үүсгэсэн PDF. */
@Injectable()
export class PortalContractService {
  private readonly logger = new Logger('PortalContract');

  constructor(
    private readonly prisma: PrismaService,
    private readonly loans: PortalLoansService,
    @Inject(PORTAL_CONTRACT_FILES) private readonly files: PortalContractFilesPort,
  ) {}

  async info(ctx: RequestContext, loanId: string): Promise<PortalContractInfo> {
    return (await this.resolve(ctx, loanId)).info;
  }

  async content(ctx: RequestContext, loanId: string): Promise<ContractPdf> {
    const { info, fileId } = await this.resolve(ctx, loanId);
    let pdf: Buffer;
    try {
      pdf = await this.files.fetchPdf(ctx, fileId);
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === 404) throw portalError.contractNotAvailable();
      throw e;
    }
    const max = Number(process.env.PORTAL_MAX_CONTRACT_BYTES) || DEFAULT_MAX_BYTES;
    if (!Buffer.isBuffer(pdf) || pdf.length === 0 || pdf.length > max || !pdf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
      this.logger.error({ msg: 'dms returned a non-PDF contract file', loanId, correlationId: ctx.correlationId, bytes: Buffer.isBuffer(pdf) ? pdf.length : null });
      throw portalError.badDownstream();
    }
    this.logger.log({ msg: 'portal contract download', loanId, signed: info.signed, correlationId: ctx.correlationId });
    return { info: { ...info, sizeBytes: pdf.length }, pdf };
  }

  private async resolve(ctx: RequestContext, loanId: string): Promise<{ info: PortalContractInfo; fileId: string }> {
    const loan = await this.loans.owned(ctx, loanId);
    const contract = await this.prisma.contract.findFirst({ where: { applicationId: loan.id, orgId: ctx.orgId } });
    const fileId = contract?.signedFileId ?? contract?.generatedFileId;
    if (!contract || !fileId) throw portalError.contractNotAvailable();
    const info = PortalContractInfo.parse({
      loanId: loan.id, contractNo: contract.contractNo, signed: !!contract.signedFileId,
      signedAt: contract.signedFileId && contract.signedAt ? contract.signedAt.toISOString() : null,
      fileName: `${contract.contractNo.replace(/[^A-Za-z0-9._-]/g, '_') || 'contract'}.pdf`, mime: 'application/pdf', sizeBytes: null,
    });
    return { info, fileId };
  }
}
