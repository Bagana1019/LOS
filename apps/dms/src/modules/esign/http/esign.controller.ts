// FR-11.4 Дотоод (origination → dms) e-sign REST. Gateway-ийн auth + CommonModule-ийн guard (`X-User-Id`, `X-Org-Id`, `X-Correlation-Id`) — CLAUDE.md §3.2.9.
// Байгууллага (org) нь толгойноос: өөр байгууллагын хүсэлт/файл 404.
// Бүх хариу `Cache-Control: no-store` — create/resend-ийн `signingUrl` нь нэг удаагийн токен агуулна.
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseFilters, UseInterceptors, type StreamableFile } from '@nestjs/common';
import { CreateSigningRequest, type RequestContext as ServiceContext, type SigningRequestView } from '@los/contracts';
import { Ctx, Permissions } from '@los/nest-common';
import { z } from 'zod';
import { SigningService, type RequestContext } from '../signing.service';
import { fileResponse } from './file-response';
import { NoStoreInterceptor } from './no-store';
import { SigningRequestIdPipe } from './params';
import { SigningExceptionFilter } from './signing-exception.filter';
import { ZodPipe } from './zod.pipe';

const ListRequestsQuery = z.object({ applicationId: z.string().min(1).max(128) });
type ListRequestsQuery = z.infer<typeof ListRequestsQuery>;

/** Ажилтны үйлдлийн контекст: gateway/origination-ы тавьсан `X-User-Id`, `X-Org-Id`, `X-Correlation-Id` */
const staff = (ctx: ServiceContext): RequestContext => ({ actorId: ctx.userId, correlationId: ctx.correlationId, orgId: ctx.orgId });

@Controller('esign')
@UseFilters(SigningExceptionFilter)
@UseInterceptors(NoStoreInterceptor)
export class EsignController {
  constructor(@Inject(SigningService) private readonly signing: SigningService) {}

  /** Хүсэлт үүсгэж, зээлдэгчийн нэг удаагийн линкийг (`signingUrl`) буцаана. Токен хадгалагдахгүй — дахин сэргээх боломжгүй */
  @Post('requests')
  @Permissions('application:write')
  async create(@Body(new ZodPipe(CreateSigningRequest)) dto: CreateSigningRequest, @Ctx() ctx: ServiceContext): Promise<SigningRequestView> {
    const { record, signingUrl } = await this.signing.createRequest({ ...dto, orgId: ctx.orgId }, staff(ctx));
    return this.signing.toView(record, signingUrl);
  }

  @Get('requests')
  @Permissions('application:read')
  async list(@Query(new ZodPipe(ListRequestsQuery)) query: ListRequestsQuery, @Ctx() ctx: ServiceContext): Promise<SigningRequestView[]> {
    const records = await this.signing.listByApplication(query.applicationId, ctx.orgId);
    return records.map((record) => this.signing.toView(record));
  }

  @Get('requests/:id')
  @Permissions('application:read')
  async get(@Param('id', SigningRequestIdPipe) id: string, @Ctx() ctx: ServiceContext): Promise<SigningRequestView> {
    return this.signing.toView(await this.signing.get(id, ctx.orgId));
  }

  /** Токеныг шинэчилнэ (хуучин линк тэр даруй үхнэ), шинэ `signingUrl` буцаана */
  @Post('requests/:id/resend')
  @Permissions('application:write')
  @HttpCode(200)
  async resend(@Param('id', SigningRequestIdPipe) id: string, @Ctx() ctx: ServiceContext): Promise<SigningRequestView> {
    const { record, signingUrl } = await this.signing.resend(id, staff(ctx));
    return this.signing.toView(record, signingUrl);
  }

  @Post('requests/:id/cancel')
  @Permissions('application:write')
  @HttpCode(200)
  async cancel(@Param('id', SigningRequestIdPipe) id: string, @Ctx() ctx: ServiceContext): Promise<SigningRequestView> {
    return this.signing.toView(await this.signing.cancel(id, staff(ctx)));
  }

  /** Гарын үсэгтэй PDF (QR + штамптай). Татсан нь audit-д бичигдэнэ */
  @Get('requests/:id/signed-document')
  @Permissions('application:read')
  async signedDocument(@Param('id', SigningRequestIdPipe) id: string, @Ctx() ctx: ServiceContext): Promise<StreamableFile> {
    return fileResponse(await this.signing.getSignedDocument(id, staff(ctx)), 'attachment');
  }

  /** Provider-ийн CMS (`.p7s`) гарын үсэг */
  @Get('requests/:id/signature')
  @Permissions('application:read')
  async signature(@Param('id', SigningRequestIdPipe) id: string, @Ctx() ctx: ServiceContext): Promise<StreamableFile> {
    return fileResponse(await this.signing.getSignature(id, staff(ctx)), 'attachment');
  }
}
