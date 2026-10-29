import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import {
  PosLeaseAdminListQuery, PosLeaseReview, PosLeaseSettle,
  type PosLeaseAdminView, type PosLeaseListItem,
} from '@los/contracts';
import { ContextGuard, Ctx } from '../common/context.guard';
import { MerchantExceptionFilter } from '../common/exception.filter';
import type { Paged } from '../common/paged';
import type { RequestContext } from '../common/request-context';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { ParseIdPipe, ZodPipe } from '../common/zod.pipe';
import { LeaseService } from '../services/lease.service';
import { BACK_OFFICE_READ } from './merchants.controller';

/** Back-office: бүх мерчантын лизинг, REFER хянах, settle (POS-FR-9). BRANCH_MANAGER зөвхөн өөрийн салбар. */
@Controller('pos-leases')
@UseGuards(ContextGuard, RolesGuard)
@UseFilters(MerchantExceptionFilter)
export class PosLeasesController {
  constructor(@Inject(LeaseService) private readonly leases: LeaseService) {}

  @Get() @Roles(...BACK_OFFICE_READ)
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(PosLeaseAdminListQuery)) query: PosLeaseAdminListQuery): Promise<Paged<PosLeaseListItem>> {
    return this.leases.listForBackOffice(ctx, query);
  }

  @Get(':id') @Roles(...BACK_OFFICE_READ)
  get(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string): Promise<PosLeaseAdminView> {
    return this.leases.getForBackOffice(ctx, id);
  }

  @Post(':id/review') @Roles(...BACK_OFFICE_READ) @HttpCode(200)
  review(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string, @Body(new ZodPipe(PosLeaseReview)) body: PosLeaseReview): Promise<PosLeaseAdminView> {
    return this.leases.review(ctx, id, body);
  }

  @Post(':id/settle') @Roles('ADMIN') @HttpCode(200)
  settle(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string, @Body(new ZodPipe(PosLeaseSettle)) body: PosLeaseSettle): Promise<PosLeaseAdminView> {
    return this.leases.settle(ctx, id, body);
  }
}
