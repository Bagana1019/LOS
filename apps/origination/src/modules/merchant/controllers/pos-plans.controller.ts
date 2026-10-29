import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { PlanCreate, PlanUpdate, type PlanView } from '@los/contracts';
import { z } from 'zod';
import { ContextGuard, Ctx } from '../common/context.guard';
import { MerchantExceptionFilter } from '../common/exception.filter';
import type { RequestContext } from '../common/request-context';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { ParseIdPipe, ZodPipe } from '../common/zod.pipe';
import { PlanService } from '../services/plan.service';
import { BACK_OFFICE_READ } from './merchants.controller';

/** `?merchantId&isActive` — contracts-д байхгүй тул route-ын дотоод схем. */
const PlanListQuery = z.object({
  merchantId: z.string().uuid().optional(),
  isActive: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
type PlanListQuery = z.infer<typeof PlanListQuery>;

/** Back-office: лизингийн хөтөлбөр (POS-FR-3). */
@Controller('pos-plans')
@UseGuards(ContextGuard, RolesGuard)
@UseFilters(MerchantExceptionFilter)
export class PosPlansController {
  constructor(@Inject(PlanService) private readonly plans: PlanService) {}

  @Post() @Roles('ADMIN')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(PlanCreate)) body: PlanCreate): Promise<PlanView> {
    return this.plans.create(ctx, body);
  }

  @Get() @Roles(...BACK_OFFICE_READ)
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(PlanListQuery)) query: PlanListQuery): Promise<PlanView[]> {
    return this.plans.list(ctx, query);
  }

  @Patch(':id') @Roles('ADMIN')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string, @Body(new ZodPipe(PlanUpdate)) body: PlanUpdate): Promise<PlanView> {
    return this.plans.update(ctx, id, body);
  }
}
