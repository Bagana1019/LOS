import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { AttachSignedContractRequest, CreateOfficialLetterRequest, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { ContractDocumentsService } from './contract-documents.service';

/**
 * FR-11 · Gateway: `/api/origination/applications/:applicationId/contract…`. Файлыг (PDF) dms-ийн `/api/files/:id/content`-оор татна.
 * Унших = `application:read`; үүсгэх/скан/албан бичиг = `application:write` (ЗЭЗ; хүрээг ApplicationAccessService шалгана).
 */
@Controller('applications/:applicationId/contract')
export class ContractDocumentsController {
  constructor(private readonly docs: ContractDocumentsService) {}

  @Permissions('application:read') @Get()
  get(@Ctx() ctx: RequestContext, @Param('applicationId') id: string) { return this.docs.get(ctx, id); }

  @Permissions('application:write') @Post('generate') @HttpCode(200)
  generate(@Ctx() ctx: RequestContext, @Param('applicationId') id: string) { return this.docs.generate(ctx, id); }

  /** Цаасан гарын үсэгтэй сканыг (dms файл) хавсаргана → G4. */
  @Permissions('application:write') @Post('signed') @HttpCode(200)
  attachSigned(@Ctx() ctx: RequestContext, @Param('applicationId') id: string, @Body(new ZodValidationPipe(AttachSignedContractRequest)) body: AttachSignedContractRequest) {
    return this.docs.attachSigned(ctx, id, body.fileId);
  }

  @Permissions('application:write') @Post('official-letters') @HttpCode(201)
  createLetter(@Ctx() ctx: RequestContext, @Param('applicationId') id: string, @Body(new ZodValidationPipe(CreateOfficialLetterRequest)) body: CreateOfficialLetterRequest) {
    return this.docs.createLetter(ctx, id, body);
  }

  @Permissions('application:write') @Post('official-letters/:letterId/print') @HttpCode(200)
  print(@Ctx() ctx: RequestContext, @Param('applicationId') id: string, @Param('letterId') letterId: string) { return this.docs.markPrinted(ctx, id, letterId); }
}
