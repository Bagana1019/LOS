// INT-9: BSA PDF тайланг dms-д хадгалж, 8-р алхамд «Дансны хуулгын шинжилгээ» (`bsa_report`) төрлөөр бүртгэнэ. origination → dms sync REST.
// Нэг хүсэлтэд ЗӨВХӨН сүүлийн тайлан үлдэнэ (өмнөхийг устгана). Тестэд `BSA_REPORT_STORE` fake-ээр солигдоно.
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { RequestContext } from '@los/contracts';
import { InternalHttpClient } from '@los/nest-common';
import { createDmsDocuments } from '../document/http-dms-documents.port';
import type { DmsDocumentsPort } from '../document/dms-documents.port';

export const BSA_REPORT_STORE = Symbol('BSA_REPORT_STORE');
export const BSA_REPORT_DOC_TYPE = 'bsa_report';

export interface BsaReportStore {
  /** true — баримтын алхамд хавсаргасан */
  store(ctx: RequestContext, applicationId: string, pdf: Buffer, fileName: string): Promise<boolean>;
}

const DmsFile = z.object({ id: z.string() }).passthrough();

export class DmsBsaReportStore implements BsaReportStore {
  private readonly logger = new Logger(DmsBsaReportStore.name);

  constructor(private readonly http: InternalHttpClient = new InternalHttpClient(), private readonly documents: DmsDocumentsPort = createDmsDocuments()) {}

  async store(ctx: RequestContext, applicationId: string, pdf: Buffer, fileName: string): Promise<boolean> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), fileName);
    const file = await this.http.post('dms', '/api/files', undefined, { ctx, timeoutMs: 15_000, form, schema: DmsFile });

    const existing = await this.documents.list({ applicationId, relatedEntity: 'APPLICATION' }, ctx);
    await this.documents.create({ applicationId, type: BSA_REPORT_DOC_TYPE, relatedEntity: 'APPLICATION', note: 'Дансны хуулгын шинжилгээ (BSA)', fileId: file.id }, ctx);
    for (const d of existing.filter((x) => x.type === BSA_REPORT_DOC_TYPE)) {
      try {
        await this.documents.remove(d.id, ctx);
      } catch {
        this.logger.warn({ msg: 'old bsa report document was not removed', applicationId, correlationId: ctx.correlationId });
      }
    }
    return true;
  }
}

export const createBsaReportStore = (): BsaReportStore => new DmsBsaReportStore();
