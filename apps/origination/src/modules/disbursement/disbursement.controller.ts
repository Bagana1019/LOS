import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { DecideDisbursementRequest, UpdateDisbursementRequest, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { DisbursementService } from './disbursement.service';

/** FR-12 · Gateway: `/api/origination/applications/:applicationId/disbursement…`. Хүрээг ApplicationAccessService шалгана. */
@Controller('applications/:applicationId/disbursement')
export class DisbursementController {
  constructor(private readonly disbursement: DisbursementService) {}

  @Permissions('application:read') @Get()
  get(@Ctx() ctx: RequestContext, @Param('applicationId') id: string) { return this.disbursement.get(ctx, id); }

  @Permissions('disbursement:request') @Put()
  update(@Ctx() ctx: RequestContext, @Param('applicationId') id: string, @Body(new ZodValidationPipe(UpdateDisbursementRequest)) body: UpdateDisbursementRequest) { return this.disbursement.update(ctx, id, body); }

  /** G4 */
  @Permissions('disbursement:request') @Post('submit') @HttpCode(200)
  submit(@Ctx() ctx: RequestContext, @Param('applicationId') id: string) { return this.disbursement.submit(ctx, id); }

  /** G5 → Core */
  @Permissions('disbursement:approve') @Post('approve') @HttpCode(200)
  approve(@Ctx() ctx: RequestContext, @Param('applicationId') id: string, @Body(new ZodValidationPipe(DecideDisbursementRequest)) body: DecideDisbursementRequest) { return this.disbursement.approve(ctx, id, body.comment); }

  @Permissions('disbursement:approve') @Post('reject') @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('applicationId') id: string, @Body(new ZodValidationPipe(DecideDisbursementRequest)) body: DecideDisbursementRequest) { return this.disbursement.reject(ctx, id, body.comment); }
}
