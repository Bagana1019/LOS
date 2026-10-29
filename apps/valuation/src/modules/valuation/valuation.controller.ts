import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import {
  AutoValuationRequest,
  VehicleLookupRequest,
  type AutoValuationResponse,
  type RequestContext,
  type VehicleLookupResponse,
} from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { AutoValuationService } from './auto-valuation.service';

// FR-14.1, FR-14.2 — vehicle collateral auto-valuation (origination → valuation, sync REST, CLAUDE.md §3.1).
// POST rather than GET so the plate number never lands in URLs or access logs (CLAUDE.md §6.5).
// marketValue is only a SUGGESTION: the haircut (collateral value) and the persistence into collateral_valuation
// belong to docs/04 Module 6 and to the caller, not to this endpoint.
// Identity comes from the gateway headers (CLAUDE.md §3.2 rule 9) and is checked by the global ContextAuthGuard; the registry
// answer carries the owner (personal data), so the lookup needs `customer:read`, the valuation (no owner) `application:read`.

@Controller('valuate')
export class ValuationController {
  constructor(@Inject(AutoValuationService) private readonly service: AutoValuationService) {}

  @Permissions('customer:read')
  @Post('vehicle-lookup')
  @HttpCode(200)
  lookupVehicle(
    @Ctx() ctx: RequestContext,
    @Body(new ZodValidationPipe(VehicleLookupRequest)) body: VehicleLookupRequest,
  ): Promise<VehicleLookupResponse> {
    return this.service.lookupVehicle(body.plateNo, ctx.correlationId);
  }

  @Permissions('application:read')
  @Post('auto')
  @HttpCode(200)
  autoValuate(
    @Ctx() ctx: RequestContext,
    @Body(new ZodValidationPipe(AutoValuationRequest)) body: AutoValuationRequest,
  ): Promise<AutoValuationResponse> {
    return this.service.autoValuateVehicle(body, ctx.correlationId);
  }
}
