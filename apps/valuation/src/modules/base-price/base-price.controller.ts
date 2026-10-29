import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { BasePriceImportRequest, BasePriceInput, BasePriceListQuery, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { BasePriceService } from './base-price.service';

// FR-14.1, FR-14.5. Reading needs application:read (the suggestion screens show the price list); changing it is the admin's settings:manage.
@Controller('base-prices')
export class BasePriceController {
  constructor(@Inject(BasePriceService) private readonly service: BasePriceService) {}

  @Permissions('application:read')
  @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(BasePriceListQuery)) query: BasePriceListQuery) {
    return this.service.list(ctx, query);
  }

  @Permissions('settings:manage')
  @Post()
  @HttpCode(201)
  create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(BasePriceInput)) body: BasePriceInput) {
    return this.service.create(ctx, body);
  }

  @Permissions('settings:manage')
  @Post('import')
  @HttpCode(201)
  import(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(BasePriceImportRequest)) body: BasePriceImportRequest) {
    return this.service.import(ctx, body);
  }
}
