// FR-9.1 Дотоод (origination → dms) баримтын REST. Gateway-ийн ажилтны proxy энэ замыг гаргахгүй (`INTERNAL_ONLY_PREFIXES` `/api/dms/documents`);
// origination хэрэглэгчийн толгойг (X-User-Id, X-Roles, X-Org-Id, X-Correlation-Id) дамжуулж дууддаг.
// ADMIN-д `application:write` байхгүй тул бүх замд `application:read` — бичих эрх, хүрээ, төлөвийн жинхэнэ шалгалт origination-д (docs/05-collateral-documents.md §4 тэмдэглэл).
import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post, Query, UseFilters } from '@nestjs/common';
import { CreateDocumentRequest, DocumentListQuery, type DocumentListResponse, type DocumentView, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { OcrErrorFilter } from '../ocr/ocr-error.filter';
import { DocumentService, type DocumentOcrExtraction } from './document.service';

@Controller('documents')
@Permissions('application:read')
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Post()
  @HttpCode(201)
  create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateDocumentRequest)) body: CreateDocumentRequest): Promise<DocumentView> {
    return this.documents.create(ctx, body);
  }

  /** Оруулсан цагаар өсөхөөр (хуучин нь эхэнд). */
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(DocumentListQuery)) query: DocumentListQuery): Promise<DocumentListResponse> {
    return { items: await this.documents.list(ctx, query) };
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<DocumentView> {
    return this.documents.get(ctx, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.documents.remove(ctx, id);
  }

  /** Хариу PII агуулна — кэшлэхгүй. OcrError → HTTP-г `/api/ocr/extract`-тэй ижил `OcrErrorFilter` хийнэ (mock-д fixture олдохгүй бол 422 NO_FIXTURE). */
  @Post(':id/ocr')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseFilters(OcrErrorFilter)
  ocr(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<DocumentOcrExtraction> {
    return this.documents.extract(ctx, id);
  }
}
