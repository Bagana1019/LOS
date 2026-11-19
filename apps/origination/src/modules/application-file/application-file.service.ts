import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RequestContext } from '@los/contracts';
import { VALUATION_PORT, type ValuationPort } from '../collateral/ports/valuation.port';
import { DMS_DOCUMENTS, type DmsDocumentsPort } from '../document/dms-documents.port';
import { PrismaService } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { APPLICATION_FILE_STORE, type ApplicationFileStorePort, type StoredFile } from './application-file.store';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * NFR-3 · хүсэлтийн файл татах (docs/DECISIONS.md 2026-11-19 "dms агуулга → origination"): ажилтан файлыг dms-ээс шууд биш ЭНДЭЭС татна.
 * 1) Хүсэлтэд хандах эрх (ApplicationAccessService: ЗЭЗ өөрийн, салбарын захирал өөрийн салбар, батлагч/админ бүгд).
 * 2) Файл ТЭР хүсэлтэд холбогдсон эсэх — өөр хүсэлтийн файлын id-аар дамжуулан татаж болохгүй. Холбоогүй бол 404 (оршихуйг нууна).
 */
@Injectable()
export class ApplicationFileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    @Inject(DMS_DOCUMENTS) private readonly documents: DmsDocumentsPort,
    @Inject(VALUATION_PORT) private readonly valuation: ValuationPort,
    @Inject(APPLICATION_FILE_STORE) private readonly store: ApplicationFileStorePort,
  ) {}

  async open(ctx: RequestContext, applicationId: string, fileId: string): Promise<StoredFile> {
    await this.access.load(ctx, applicationId, 'read');
    if (!UUID.test(fileId) || !(await this.isLinked(ctx, applicationId, fileId))) {
      throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: 'Файл олдсонгүй' });
    }
    return this.store.fetch(ctx, fileId);
  }

  /** Хямд (өөрийн DB) → dms баримт → valuation тайлан дарааллаар; эхний таарсанд зогсоно. */
  private async isLinked(ctx: RequestContext, applicationId: string, fileId: string): Promise<boolean> {
    return (await this.inOwnTables(ctx.orgId, applicationId, fileId))
      || (await this.inDmsDocuments(ctx, applicationId, fileId))
      || (await this.inValuationReports(ctx, applicationId, fileId));
  }

  /** Гэрээ (үүсгэсэн/гарын үсэгтэй), албан бичиг, барьцааны баримт. */
  private async inOwnTables(orgId: string, applicationId: string, fileId: string): Promise<boolean> {
    const [contract, letter, collateralDoc] = await Promise.all([
      this.prisma.contract.findFirst({ where: { orgId, applicationId, OR: [{ generatedFileId: fileId }, { signedFileId: fileId }] }, select: { id: true } }),
      this.prisma.officialLetter.findFirst({ where: { orgId, applicationId, generatedFileId: fileId }, select: { id: true } }),
      this.prisma.collateralDocument.findFirst({ where: { orgId, fileId, collateral: { applicationId } }, select: { id: true } }),
    ]);
    return !!(contract || letter || collateralDoc);
  }

  private async inDmsDocuments(ctx: RequestContext, applicationId: string, fileId: string): Promise<boolean> {
    return (await this.documents.list({ applicationId }, ctx)).some((d) => d.fileId === fileId);
  }

  private async inValuationReports(ctx: RequestContext, applicationId: string, fileId: string): Promise<boolean> {
    const collaterals = await this.prisma.collateral.findMany({ where: { orgId: ctx.orgId, applicationId }, select: { id: true } });
    const histories = await Promise.all(collaterals.map((c) => this.valuation.history(ctx, c.id)));
    return histories.some((h) => h.items.some((v) => v.reportFileId === fileId));
  }
}
