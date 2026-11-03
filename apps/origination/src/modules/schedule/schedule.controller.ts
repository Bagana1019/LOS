import { Body, Controller, Get, HttpCode, Param, Post, StreamableFile } from '@nestjs/common';
import { ScheduleParamsRequest, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { ScheduleService } from './schedule.service';

/**
 * FR-7 · Gateway: `/api/origination/applications/:applicationId/schedule…`.
 * Унших / урьдчилж харах / Excel = `application:read`; үүсгэх = `application:write` (хүрээг ApplicationAccessService шалгана). CUSTOMER эрхгүй.
 */
@Controller('applications/:applicationId/schedule')
export class ScheduleController {
  constructor(private readonly schedule: ScheduleService) {}

  @Permissions('application:read') @Get()
  get(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string) { return this.schedule.get(ctx, applicationId); }

  @Permissions('application:read') @Post('preview') @HttpCode(200)
  preview(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(ScheduleParamsRequest)) body: ScheduleParamsRequest) {
    return this.schedule.preview(ctx, applicationId, body);
  }

  @Permissions('application:write') @Post() @HttpCode(200)
  generate(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string, @Body(new ZodValidationPipe(ScheduleParamsRequest)) body: ScheduleParamsRequest) {
    return this.schedule.generate(ctx, applicationId, body);
  }

  @Permissions('application:read') @Get('export')
  async export(@Ctx() ctx: RequestContext, @Param('applicationId') applicationId: string): Promise<StreamableFile> {
    const file = await this.schedule.exportXlsx(ctx, applicationId);
    return new StreamableFile(file.buffer, { type: file.mime, disposition: `attachment; filename="${file.filename}"`, length: file.buffer.length });
  }
}
