import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import {
  MerchantCreate, MerchantListQuery, MerchantStatusChange, MerchantUpdate, StoreCreate, StoreUpdate,
  type MerchantView, type StoreView,
} from '@los/contracts';
import { ContextGuard, Ctx } from '../common/context.guard';
import { MerchantExceptionFilter } from '../common/exception.filter';
import type { Paged } from '../common/paged';
import type { RequestContext } from '../common/request-context';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { ParseIdPipe, ZodPipe } from '../common/zod.pipe';
import { MerchantService } from '../services/merchant.service';

export const BACK_OFFICE_READ = ['ADMIN', 'APPROVER', 'BRANCH_MANAGER'] as const;

/** Back-office: мерчант, дэлгүүр (docs/05 §8). Бичих = ADMIN; унших = ADMIN/APPROVER/BRANCH_MANAGER (салбараар хязгаарлагдана). */
@Controller('merchants')
@UseGuards(ContextGuard, RolesGuard)
@UseFilters(MerchantExceptionFilter)
export class MerchantsController {
  constructor(@Inject(MerchantService) private readonly merchants: MerchantService) {}

  @Post() @Roles('ADMIN')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(MerchantCreate)) body: MerchantCreate): Promise<MerchantView> {
    return this.merchants.create(ctx, body);
  }

  @Get() @Roles(...BACK_OFFICE_READ)
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(MerchantListQuery)) query: MerchantListQuery): Promise<Paged<MerchantView>> {
    return this.merchants.list(ctx, query);
  }

  @Get(':id') @Roles(...BACK_OFFICE_READ)
  get(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string): Promise<MerchantView> {
    return this.merchants.get(ctx, id);
  }

  @Patch(':id') @Roles('ADMIN')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string, @Body(new ZodPipe(MerchantUpdate)) body: MerchantUpdate): Promise<MerchantView> {
    return this.merchants.update(ctx, id, body);
  }

  @Post(':id/status') @Roles('ADMIN') @HttpCode(200)
  changeStatus(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string, @Body(new ZodPipe(MerchantStatusChange)) body: MerchantStatusChange): Promise<MerchantView> {
    return this.merchants.changeStatus(ctx, id, body);
  }

  @Post(':id/stores') @Roles('ADMIN')
  createStore(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string, @Body(new ZodPipe(StoreCreate)) body: StoreCreate): Promise<StoreView> {
    return this.merchants.createStore(ctx, id, body);
  }

  @Get(':id/stores') @Roles(...BACK_OFFICE_READ)
  listStores(@Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string): Promise<StoreView[]> {
    return this.merchants.listStores(ctx, id);
  }

  @Patch(':id/stores/:storeId') @Roles('ADMIN')
  updateStore(
    @Ctx() ctx: RequestContext, @Param('id', ParseIdPipe) id: string, @Param('storeId', ParseIdPipe) storeId: string, @Body(new ZodPipe(StoreUpdate)) body: StoreUpdate,
  ): Promise<StoreView> {
    return this.merchants.updateStore(ctx, id, storeId, body);
  }
}
