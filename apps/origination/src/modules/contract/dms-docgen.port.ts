import type { ContractTemplateType, RenderTemplateRequest, RenderTemplateResponse, RequestContext } from '@los/contracts';

// origination → dms sync REST (CLAUDE.md §3.2.2): загвараас гэрээ/ЭТХ/албан бичиг PDF үүсгэх, файл байгаа эсэх. Бодит нь `HttpDmsDocgen`; тест `testing/fake-dms-docgen.ts`.
export interface DmsDocgenPort {
  render(req: RenderTemplateRequest, ctx: RequestContext): Promise<RenderTemplateResponse>;
  /** dms файл (өөрийн байгууллагын) олдох эсэх — цаасан гарын үсгийн скан хавсаргахад. */
  fileExists(fileId: string, ctx: RequestContext): Promise<boolean>;
  /** Идэвхтэй загвар байгаа эсэх (productId → нийтлэг). Албан бичиг үүсгэхийн өмнөх сануулга. */
  hasTemplate(type: ContractTemplateType, productId: string | null, ctx: RequestContext): Promise<boolean>;
}
export const DMS_DOCGEN = Symbol('DMS_DOCGEN');
