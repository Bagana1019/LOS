import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CreateSigningRequest, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { ContractSigningService } from './contract-signing.service';
import type { StaffSigningRequestView } from './signing-view';

const ApplicationId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** Хязгаарыг dms-ийн DTO-оос авна. `supersedeActive` зэрэг бусад талбарыг зөвшөөрөхгүй (strict) — идэвхтэй хүсэлтийг ажилтан түрж цуцлах боломжгүй */
const StartSigningBody = CreateSigningRequest.pick({ preferredProvider: true, ttlHours: true }).strict().default({});

/**
 * FR-11.4. Gateway: `/api/origination/contracts/:applicationId/esign`. Хариу нь signingUrl-гүй.
 * Эрх: өөрчлөх үйлдэл `application:write` (ЗЭЗ), төлөв харах `application:read`; хүрээ (NFR-3) нь service-д `assertInScope`.
 */
@Controller('contracts/:applicationId/esign')
export class ContractSigningController {
  constructor(@Inject(ContractSigningService) private readonly signing: ContractSigningService) {}

  @Post() @Permissions('application:write')
  start(
    @Param('applicationId', new ZodValidationPipe(ApplicationId)) applicationId: string,
    @Body(new ZodValidationPipe(StartSigningBody)) body: z.infer<typeof StartSigningBody>,
    @Ctx() ctx: RequestContext,
  ): Promise<StaffSigningRequestView> {
    return this.signing.start(applicationId, body, ctx);
  }

  @Post('resend') @HttpCode(200) @Permissions('application:write')
  resend(@Param('applicationId', new ZodValidationPipe(ApplicationId)) applicationId: string, @Ctx() ctx: RequestContext): Promise<StaffSigningRequestView> {
    return this.signing.resend(applicationId, ctx);
  }

  @Post('cancel') @HttpCode(200) @Permissions('application:write')
  cancel(@Param('applicationId', new ZodValidationPipe(ApplicationId)) applicationId: string, @Ctx() ctx: RequestContext): Promise<StaffSigningRequestView> {
    return this.signing.cancel(applicationId, ctx);
  }

  @Get() @Permissions('application:read')
  status(@Param('applicationId', new ZodValidationPipe(ApplicationId)) applicationId: string, @Ctx() ctx: RequestContext): Promise<StaffSigningRequestView> {
    return this.signing.getStatus(applicationId, ctx);
  }
}
