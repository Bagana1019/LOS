import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { AssetType, HaircutRuleInput, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { HaircutService } from './haircut.service';

/** `productId=null` → only the org-wide rules (rules for "all products"); no `productId` → every rule. */
const HaircutListQuery = z.object({
  productId: z.string().trim().min(1).max(100).optional(),
  assetType: z.enum(AssetType).optional(),
  includeInactive: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});
type HaircutListQuery = z.infer<typeof HaircutListQuery>;

// FR-14.2. Reading needs application:read; changing a rule is the admin's settings:manage.
@Controller('haircuts')
export class HaircutController {
  constructor(@Inject(HaircutService) private readonly service: HaircutService) {}

  @Permissions('application:read')
  @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(HaircutListQuery)) q: HaircutListQuery) {
    return this.service.list(ctx, { productId: q.productId === undefined ? undefined : q.productId === 'null' ? null : q.productId, assetType: q.assetType, includeInactive: q.includeInactive });
  }

  @Permissions('settings:manage')
  @Put()
  upsert(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(HaircutRuleInput)) body: HaircutRuleInput) {
    return this.service.upsert(ctx, body);
  }

  @Permissions('settings:manage')
  @Delete(':id')
  @HttpCode(200)
  remove(@Ctx() ctx: RequestContext, @Param('id', new ZodValidationPipe(z.string().uuid())) id: string) {
    return this.service.deactivate(ctx, id);
  }
}
