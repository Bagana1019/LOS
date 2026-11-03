import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { ContractTemplateType, RenderTemplateRequest, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { maxFileBytes, type UploadedFile as Upload } from '../file/file.service';
import { TemplateService } from './template.service';

const CreateTemplateBody = z.object({ type: z.enum(ContractTemplateType), name: z.string().trim().min(1).max(120), productId: z.string().max(64).optional().transform((v) => v || null) });
const ListQuery = z.object({ productId: z.string().max(64).optional(), type: z.enum(ContractTemplateType).optional(), activeOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true') });
const ActiveBody = z.object({ isActive: z.boolean() });

/** FR-11.1/11.2. Загвар засах = `settings:manage` (ADMIN). Унших/PDF үүсгэх нь origination-ийн дотоод дуудлага (`application:read`). */
@Controller('templates')
export class TemplateController {
  constructor(private readonly templates: TemplateService) {}

  @Permissions('application:read') @Get('placeholders') placeholders() { return { items: this.templates.catalog() }; }

  @Permissions('application:read') @Get()
  async list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return { items: await this.templates.list(ctx, { productId: q.productId, type: q.type, activeOnly: q.activeOnly }) };
  }

  /** `multipart/form-data`: талбар `file` (.docx), `type`, `name`, `productId`(заавал биш). */
  @Permissions('settings:manage') @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: maxFileBytes() + 1, files: 1 } }))
  create(@Ctx() ctx: RequestContext, @UploadedFile() file: Upload | undefined, @Body(new ZodValidationPipe(CreateTemplateBody)) body: z.infer<typeof CreateTemplateBody>) {
    return this.templates.create(ctx, file, body);
  }

  /** DEMO загвар суулгах (идэмпотент). */
  @Permissions('settings:manage') @Post('demo') @HttpCode(200)
  async demo(@Ctx() ctx: RequestContext) { return { installed: await this.templates.installDemo(ctx) }; }

  @Permissions('settings:manage') @Patch(':id/active')
  setActive(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodValidationPipe(ActiveBody)) body: z.infer<typeof ActiveBody>) {
    return this.templates.setActive(ctx, id, body.isActive);
  }

  /** Загвараас docx + PDF үүсгэж dms файл болгоно (origination дууддаг). */
  @Permissions('application:read') @Post('render') @HttpCode(200)
  render(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(RenderTemplateRequest)) body: RenderTemplateRequest) {
    return this.templates.render(ctx, body);
  }
}
