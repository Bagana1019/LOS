import { Body, Controller, Delete, Get, Header, HttpCode, Param, Post } from '@nestjs/common';
import { AttachDocumentRequest, type ApplicationDocumentMutationResponse, type ApplicationDocumentsResponse, type DocumentOcrCheck, type RequestContext } from '@los/contracts';
import { Ctx, Roles, ZodValidationPipe } from '@los/nest-common';
import { ApplicationDocumentService } from './document.service';

// FR-9.1, FR-9.2: ЗЭЗ зөвхөн өөрийн хүсэлтэд (бичих), салбарын захирал/батлагч унших; хүрээ, төлвийг ApplicationAccessService / үйлчилгээ шалгана.
const READERS = ['OFFICER', 'BRANCH_MANAGER', 'APPROVER', 'ADMIN'];
const WRITERS = ['OFFICER', 'ADMIN'];

@Controller()
export class DocumentController {
  constructor(private readonly documents: ApplicationDocumentService) {}

  @Get('applications/:applicationId/documents')
  @Roles(...READERS)
  list(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string): Promise<ApplicationDocumentsResponse> {
    return this.documents.list(ctx, applicationId);
  }

  @Post('applications/:applicationId/documents')
  @Roles(...WRITERS)
  @HttpCode(201)
  attach(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(AttachDocumentRequest)) body: AttachDocumentRequest): Promise<ApplicationDocumentMutationResponse> {
    return this.documents.attach(ctx, applicationId, body);
  }

  @Delete('applications/:applicationId/documents/:docId')
  @Roles(...WRITERS)
  @HttpCode(200)
  remove(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('docId') docId: string): Promise<ApplicationDocumentMutationResponse> {
    return this.documents.remove(ctx, applicationId, docId);
  }

  /** OCR-ийн дүгнэлт зөвлөмж, хадгалагдахгүй; регистр (далдлагдсан) агуулна тул кэшлэхгүй. */
  @Post('applications/:applicationId/documents/:docId/ocr')
  @Roles(...WRITERS)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  ocr(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('docId') docId: string): Promise<DocumentOcrCheck> {
    return this.documents.ocrCheck(ctx, applicationId, docId);
  }
}
