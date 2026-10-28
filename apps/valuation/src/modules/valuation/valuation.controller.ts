import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import {
  AutoValuationRequest,
  VehicleLookupRequest,
  type AutoValuationResponse,
  type VehicleLookupResponse,
} from '@los/contracts';
import { CorrelationId } from '../../common/correlation-id';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AutoValuationService } from './auto-valuation.service';

// FR-14.1, FR-14.2 — vehicle collateral auto-valuation (origination → valuation, sync REST, CLAUDE.md §3.1).
// POST rather than GET so the plate number never lands in URLs or access logs (CLAUDE.md §6.5).
// marketValue is only a SUGGESTION: the haircut (collateral value) and the persistence into collateral_valuation
// belong to docs/04 Module 6 and to the caller, not to this endpoint.

@Controller('valuate')
export class ValuationController {
  constructor(@Inject(AutoValuationService) private readonly service: AutoValuationService) {}

  @Post('vehicle-lookup')
  @HttpCode(200)
  lookupVehicle(
    @Body(new ZodValidationPipe(VehicleLookupRequest)) body: VehicleLookupRequest,
    @CorrelationId() correlationId: string,
  ): Promise<VehicleLookupResponse> {
    return this.service.lookupVehicle(body.plateNo, correlationId);
  }

  @Post('auto')
  @HttpCode(200)
  autoValuate(
    @Body(new ZodValidationPipe(AutoValuationRequest)) body: AutoValuationRequest,
    @CorrelationId() correlationId: string,
  ): Promise<AutoValuationResponse> {
    return this.service.autoValuateVehicle(body, correlationId);
  }
}
