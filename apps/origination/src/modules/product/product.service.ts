import { Injectable } from '@nestjs/common';
import {
  PRODUCT_ACTION_CREATE, PRODUCT_ACTION_SET_ACTIVE, PRODUCT_ACTION_UPDATE, PRODUCT_TARGET_TYPE,
  type ProductAdminDto, type ProductCreateRequest, type ProductSetActiveRequest, type ProductUpdateRequest, type RequestContext, type SubmitChangeResult,
} from '@los/contracts';
import { DomainError } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { actorFrom } from '../maker-checker/actor';
import { MakerCheckerService } from '../maker-checker/maker-checker.service';
import { toAdminDto } from './product-view';

/** FR-13 · Бүтээгдэхүүний админ. Унших шууд; үүсгэх/засах/идэвхгүй болгох нь зөвхөн санал (4 нүд) — хэрэгжилт `product-change.handler.ts`. */
@Injectable()
export class ProductService {
  constructor(private readonly db: PrismaService, private readonly mc: MakerCheckerService) {}

  async list(ctx: RequestContext): Promise<ProductAdminDto[]> {
    const rows = await this.db.product.findMany({ where: { orgId: ctx.orgId }, orderBy: [{ isActive: 'desc' }, { code: 'asc' }] });
    const counts = await this.db.loanApplication.groupBy({ by: ['productId'], where: { orgId: ctx.orgId }, _count: { _all: true } });
    const byId = new Map(counts.map((c) => [c.productId, c._count._all]));
    return rows.map((p) => toAdminDto(p, byId.get(p.id) ?? 0));
  }

  async get(ctx: RequestContext, id: string): Promise<ProductAdminDto> {
    const p = await this.db.product.findFirst({ where: { id, orgId: ctx.orgId } });
    if (!p) throw new DomainError('PRODUCT_NOT_FOUND', 'Бүтээгдэхүүн олдсонгүй', 404);
    return toAdminDto(p, await this.db.loanApplication.count({ where: { orgId: ctx.orgId, productId: id } }));
  }

  proposeCreate(ctx: RequestContext, body: ProductCreateRequest): Promise<SubmitChangeResult> {
    return this.mc.submit(actorFrom(ctx), { targetType: PRODUCT_TARGET_TYPE, action: PRODUCT_ACTION_CREATE, targetId: body.product.code, payload: { product: body.product }, reason: body.reason });
  }

  async proposeUpdate(ctx: RequestContext, id: string, body: ProductUpdateRequest): Promise<SubmitChangeResult> {
    await this.get(ctx, id);
    return this.mc.submit(actorFrom(ctx), { targetType: PRODUCT_TARGET_TYPE, action: PRODUCT_ACTION_UPDATE, targetId: id, payload: { id, product: body.product }, reason: body.reason });
  }

  async proposeSetActive(ctx: RequestContext, id: string, body: ProductSetActiveRequest): Promise<SubmitChangeResult> {
    await this.get(ctx, id);
    return this.mc.submit(actorFrom(ctx), { targetType: PRODUCT_TARGET_TYPE, action: PRODUCT_ACTION_SET_ACTIVE, targetId: id, payload: { id, isActive: body.isActive }, reason: body.reason });
  }
}
