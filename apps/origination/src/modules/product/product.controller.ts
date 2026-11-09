import { Body, Controller, Get, Param, Post, Put, Res } from '@nestjs/common';
import { ProductCreateRequest, ProductSetActiveRequest, ProductUpdateRequest, type RequestContext, type SubmitChangeResult } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { ProductService } from './product.service';

type StatusRes = { status(code: number): unknown };
const accepted = (res: StatusRes) => (r: SubmitChangeResult) => { res.status(r.outcome === 'PENDING' ? 202 : 201); return r; };

/**
 * FR-13 · Бүтээгдэхүүний админ. Gateway: `/api/origination/products` (route-policy: бичих = settings:manage, ADMIN). Устгах endpoint байхгүй (идэвхгүй болгоно).
 * Бичих бүр 4 нүдний санал үүсгэнэ: 202 PENDING / 201 APPLIED_DIRECT (бодлого идэвхгүй бол). Хэрэглэгчийн хүсэлтэд ашиглах жагсаалт нь `GET loan-terms/products`.
 */
@Controller('products')
export class ProductController {
  constructor(private readonly products: ProductService) {}

  @Permissions('settings:manage') @Get()
  list(@Ctx() ctx: RequestContext) { return this.products.list(ctx); }

  @Permissions('settings:manage') @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) { return this.products.get(ctx, id); }

  @Permissions('settings:manage') @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(ProductCreateRequest)) body: ProductCreateRequest, @Res({ passthrough: true }) res: StatusRes) {
    return this.products.proposeCreate(ctx, body).then(accepted(res));
  }

  @Permissions('settings:manage') @Put(':id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodValidationPipe(ProductUpdateRequest)) body: ProductUpdateRequest, @Res({ passthrough: true }) res: StatusRes) {
    return this.products.proposeUpdate(ctx, id, body).then(accepted(res));
  }

  @Permissions('settings:manage') @Post(':id/active')
  setActive(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body(new ZodValidationPipe(ProductSetActiveRequest)) body: ProductSetActiveRequest, @Res({ passthrough: true }) res: StatusRes) {
    return this.products.proposeSetActive(ctx, id, body).then(accepted(res));
  }
}
