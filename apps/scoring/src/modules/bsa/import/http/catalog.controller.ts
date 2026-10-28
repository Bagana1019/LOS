// BSA-FR-3.3 / 3.5: ангиллын сан, дүрмийн сан. Ангилал бүх үүрэгт; дүрэм (хэв нь гүйлгээний утгаас гарсан тул PII байж болно) зөвхөн ADMIN.
import { Body, Controller, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { BsaCategoryListQuery, BsaCreateRuleHttpRequest } from '@los/contracts';
import { Ctx, RequestContextGuard } from '../../common/request-context';
import type { RequestContext } from '../../common/infra.ports';
import type { BsaCategoryDef, BsaRuleDef } from '../../classify';
import { ReclassifyService, type CreateRuleResult } from '../reclassify.service';
import { ADMIN_ONLY, READ_ROLES, Roles, RolesGuard } from './roles';
import { ZodValidationPipe } from './zod-validation.pipe';

@Controller('bsa')
@UseGuards(RequestContextGuard, RolesGuard)
export class BsaCatalogController {
  constructor(@Inject(ReclassifyService) private readonly reclassify: ReclassifyService) {}

  @Get('categories')
  @Roles(...READ_ROLES)
  categories(
    @Ctx() ctx: RequestContext,
    @Query(new ZodValidationPipe(BsaCategoryListQuery)) q: BsaCategoryListQuery,
  ): Promise<BsaCategoryDef[]> {
    return this.reclassify.listCategories(ctx, { includeInactive: q.includeInactive });
  }

  @Get('rules')
  @Roles(...ADMIN_ONLY)
  rules(@Ctx() ctx: RequestContext): Promise<Array<BsaRuleDef & { id: string }>> {
    return this.reclassify.listRules(ctx);
  }

  /** Админ дүрэм, эсвэл `suggestedRule`-ийг хянаад баталгаажуулсан дүрэм (`source: FEEDBACK`). `analysisId` өгвөл тэр шинжилгээг дахин ангилна */
  @Post('rules')
  @HttpCode(201)
  @Roles(...ADMIN_ONLY)
  createRule(
    @Ctx() ctx: RequestContext,
    @Body(new ZodValidationPipe(BsaCreateRuleHttpRequest)) body: BsaCreateRuleHttpRequest,
  ): Promise<CreateRuleResult> {
    const { analysisId, ...rule } = body;
    return this.reclassify.createRule(ctx, rule, analysisId === undefined ? {} : { analysisId });
  }
}
