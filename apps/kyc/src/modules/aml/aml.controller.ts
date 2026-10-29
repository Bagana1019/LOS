import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { z } from 'zod';
import { AmlHitReviewRequest, AmlScreenRequest, HitStatus, ScreeningList } from '@los/contracts';
import { AmlAccessGuard, Ctx, Roles, type RequestContext } from './aml.context';
import { AmlService } from './aml.service';
import { DbInputErrorInterceptor } from './db-error.interceptor';
import { PathParam, ZodPipe } from './zod.pipe';

/** Хэт том offset нь DB-д 500 болдог тул дээд хязгаартай. */
const MAX_OFFSET = 1_000_000;
const HitQuery = z.object({
  status: z.enum(HitStatus).optional(),
  list: z.enum(ScreeningList).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
});
const RescreenBody = z.object({ limit: z.number().int().min(1).max(500).default(50) });
const RefreshBody = z.object({ list: z.enum(['UN_SC', 'FATF']).optional() });

/** Compliance & AML (FR-2.5, FR-3.4, BR-9). Эрх gateway-д шийдэгдэнэ; энд зөвхөн дүрийн шалгалт (CLAUDE.md §3.2.9). */
@Controller('aml')
@UseGuards(AmlAccessGuard)
@UseInterceptors(DbInputErrorInterceptor)
export class AmlController {
  constructor(@Inject(AmlService) private readonly aml: AmlService) {}

  /** origination → kyc (sync REST). */
  @Post('screen')
  screen(@Body(new ZodPipe(AmlScreenRequest)) body: AmlScreenRequest, @Ctx() ctx: RequestContext) {
    return this.aml.screen(body, ctx);
  }

  @Get('screenings/:id')
  screening(@Param('id', PathParam) id: string, @Ctx() ctx: RequestContext) {
    return this.aml.getScreening(ctx.orgId, id);
  }

  @Get('customers/:customerId/latest')
  latest(@Param('customerId', PathParam) customerId: string, @Ctx() ctx: RequestContext) {
    return this.aml.latestForCustomer(ctx.orgId, customerId);
  }

  /** Шийдвэрлэх дараалал. */
  @Get('hits')
  @Roles('ADMIN', 'APPROVER')
  hits(@Query(new ZodPipe(HitQuery)) q: z.infer<typeof HitQuery>, @Ctx() ctx: RequestContext) {
    return this.aml.listHits(ctx.orgId, q);
  }

  @Post('hits/:id/review')
  @HttpCode(200)
  @Roles('ADMIN', 'APPROVER')
  review(@Param('id', PathParam) id: string, @Body(new ZodPipe(AmlHitReviewRequest)) body: AmlHitReviewRequest, @Ctx() ctx: RequestContext) {
    return this.aml.reviewHit(ctx, id, body);
  }

  @Get('lists')
  @Roles('ADMIN', 'APPROVER')
  lists(@Ctx() ctx: RequestContext) {
    return this.aml.listStatuses(ctx.orgId);
  }

  @Post('lists/refresh')
  @HttpCode(200)
  @Roles('ADMIN')
  async refresh(@Body(new ZodPipe(RefreshBody)) body: z.infer<typeof RefreshBody>, @Ctx() ctx: RequestContext) {
    await this.aml.refreshLists(body.list);
    return this.aml.listStatuses(ctx.orgId);
  }

  /** Жагсаалт шинэчлэгдсэний дараа хуучин хувилбараар шалгагдсан харилцагчдыг дахин шалгана. */
  @Post('rescreen')
  @HttpCode(200)
  @Roles('ADMIN')
  rescreen(@Body(new ZodPipe(RescreenBody)) body: z.infer<typeof RescreenBody>, @Ctx() ctx: RequestContext) {
    return this.aml.rescreenOutdated(ctx, body.limit);
  }
}
