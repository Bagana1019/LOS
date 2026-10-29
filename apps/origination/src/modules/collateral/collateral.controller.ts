import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  AttachCollateralDocumentRequest, CollateralMonitoringQuery, CreateCollateralRequest, ExternalValuationRequest, OwnershipCheckRequest, RegisterPledgeRequest, RunEncumbranceCheckRequest,
  SaveValuationRequest, UpdateCollateralRequest, XypAssetsQuery,
} from '@los/contracts';
import type { RequestContext } from '@los/contracts';
import { Ctx, Roles, ZodValidationPipe } from '@los/nest-common';
import { CollateralChecksService } from './collateral-checks.service';
import { CollateralDocumentService } from './collateral-document.service';
import { CollateralValuationService } from './collateral-valuation.service';
import { CollateralService } from './collateral.service';

// docs/05 §3.1, docs/01 §3: унших — ЗЭЗ (өөрийн), салбарын захирал (салбар), батлагч, админ; бичих — ЗЭЗ (өөрийн хүсэлт), админ. Хүрээг ApplicationAccessService шалгана.
const READERS = ['OFFICER', 'BRANCH_MANAGER', 'APPROVER', 'ADMIN'];
const WRITERS = ['OFFICER', 'ADMIN'];
const base = 'applications/:applicationId/collaterals';

/** Санал авахад зөвхөн гүйлт (VEHICLE) шаардлагатай. */
const SuggestBody = SaveValuationRequest.pick({ mileageKm: true });

@Controller()
export class CollateralController {
  constructor(
    private readonly collaterals: CollateralService,
    private readonly checks: CollateralChecksService,
    private readonly valuation: CollateralValuationService,
    private readonly documents: CollateralDocumentService,
  ) {}

  // ── статик замууд `:collateralId`-аас ӨМНӨ ─────────────────────────────────────────────
  @Get('collaterals/monitoring')
  @Roles(...READERS)
  monitoring(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(CollateralMonitoringQuery)) query: CollateralMonitoringQuery) {
    return this.collaterals.monitoring(ctx, query);
  }

  @Get(`${base}/xyp-assets`)
  @Roles(...WRITERS)
  xypAssets(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Query(new ZodValidationPipe(XypAssetsQuery)) query: XypAssetsQuery) {
    return this.checks.xypAssets(ctx, applicationId, query.ownerCustomerId);
  }

  @Post(`${base}/recheck`)
  @Roles(...WRITERS)
  @HttpCode(200)
  recheck(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) {
    return this.collaterals.recheck(ctx, applicationId);
  }

  // ── барьцаа ───────────────────────────────────────────────────────────────────────────
  @Get(base)
  @Roles(...READERS)
  list(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) {
    return this.collaterals.list(ctx, applicationId);
  }

  @Post(base)
  @Roles(...WRITERS)
  @HttpCode(201)
  create(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(CreateCollateralRequest)) body: CreateCollateralRequest) {
    return this.collaterals.create(ctx, applicationId, body);
  }

  @Patch(`${base}/:collateralId`)
  @Roles(...WRITERS)
  update(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('collateralId') collateralId: string, @Body(new ZodValidationPipe(UpdateCollateralRequest)) body: UpdateCollateralRequest) {
    return this.collaterals.update(ctx, applicationId, collateralId, body);
  }

  @Delete(`${base}/:collateralId`)
  @Roles(...WRITERS)
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('collateralId') collateralId: string): Promise<void> {
    await this.collaterals.remove(ctx, applicationId, collateralId);
  }

  // ── өмчлөл, ачаалал ───────────────────────────────────────────────────────────────────
  @Post(`${base}/:collateralId/ownership-check`)
  @Roles(...WRITERS)
  @HttpCode(200)
  ownership(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('collateralId') collateralId: string, @Body(new ZodValidationPipe(OwnershipCheckRequest)) body: OwnershipCheckRequest) {
    return this.checks.checkOwnership(ctx, applicationId, collateralId, body);
  }

  @Post(`${base}/:collateralId/encumbrance-check`)
  @Roles(...WRITERS)
  @HttpCode(200)
  encumbrance(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('collateralId') collateralId: string, @Body(new ZodValidationPipe(RunEncumbranceCheckRequest)) body: RunEncumbranceCheckRequest) {
    return this.checks.checkEncumbrance(ctx, applicationId, collateralId, body);
  }

  // ── үнэлгээ ───────────────────────────────────────────────────────────────────────────
  @Post(`${base}/:collateralId/valuation/suggest`)
  @Roles(...WRITERS)
  @HttpCode(200)
  suggest(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('collateralId') collateralId: string, @Body(new ZodValidationPipe(SuggestBody)) body: { mileageKm?: number }) {
    return this.valuation.suggest(ctx, applicationId, collateralId, body);
  }

  @Post(`${base}/:collateralId/valuation/external`)
  @Roles(...WRITERS)
  @HttpCode(200)
  external(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('collateralId') collateralId: string, @Body(new ZodValidationPipe(ExternalValuationRequest)) body: ExternalValuationRequest) {
    return this.valuation.recordExternal(ctx, applicationId, collateralId, body);
  }

  @Post(`${base}/:collateralId/valuation`)
  @Roles(...WRITERS)
  @HttpCode(200)
  saveValuation(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('collateralId') collateralId: string, @Body(new ZodValidationPipe(SaveValuationRequest)) body: SaveValuationRequest) {
    return this.valuation.save(ctx, applicationId, collateralId, body);
  }

  @Get(`${base}/:collateralId/valuations`)
  @Roles(...READERS)
  history(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('collateralId') collateralId: string) {
    return this.valuation.history(ctx, applicationId, collateralId);
  }

  // ── баримт ────────────────────────────────────────────────────────────────────────────
  @Post(`${base}/:collateralId/documents`)
  @Roles(...WRITERS)
  @HttpCode(201)
  attach(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('collateralId') collateralId: string, @Body(new ZodValidationPipe(AttachCollateralDocumentRequest)) body: AttachCollateralDocumentRequest) {
    return this.documents.attach(ctx, applicationId, collateralId, body);
  }

  @Delete(`${base}/:collateralId/documents/:documentId`)
  @Roles(...WRITERS)
  @HttpCode(200)
  detach(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('collateralId') collateralId: string, @Param('documentId') documentId: string) {
    return this.documents.remove(ctx, applicationId, collateralId, documentId);
  }

  // ── ЭБ, чөлөөлөлт (FR-6.9) ─────────────────────────────────────────────────────────────
  @Post(`${base}/:collateralId/registry`)
  @Roles(...WRITERS)
  @HttpCode(200)
  registry(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('collateralId') collateralId: string, @Body(new ZodValidationPipe(RegisterPledgeRequest)) body: RegisterPledgeRequest) {
    return this.collaterals.registerPledge(ctx, applicationId, collateralId, body);
  }

  @Post(`${base}/:collateralId/release`)
  @Roles(...WRITERS)
  @HttpCode(200)
  release(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Param('collateralId') collateralId: string) {
    return this.collaterals.release(ctx, applicationId, collateralId);
  }
}
