import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import type { RequestContext } from '@los/contracts';
import { Ctx, Permissions } from '@los/nest-common';
import { z } from 'zod';
import { ZodValidationPipe } from '@los/nest-common';
import { SettingsService } from './settings.service';

const SetSettingBody = z.object({ value: z.unknown().refine((v) => v !== undefined, 'value is required') });

/** FR-13 · Тохиргоо. Унших — нэвтэрсэн бүх хэрэглэгч/сервис; өөрчлөх — `settings:manage` (ADMIN). */
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get() list(@Ctx() ctx: RequestContext) { return this.settings.list(ctx); }
  @Get(':key') get(@Ctx() ctx: RequestContext, @Param('key') key: string) { return this.settings.get(ctx, key); }

  @Permissions('settings:manage') @Put(':key')
  set(@Ctx() ctx: RequestContext, @Param('key') key: string, @Body(new ZodValidationPipe(SetSettingBody)) body: z.infer<typeof SetSettingBody>) {
    return this.settings.set(ctx, key, body.value);
  }
}
