import { Body, Controller, Get, Param, Put, Res } from '@nestjs/common';
import { isFourEyesSettingKey, type RequestContext } from '@los/contracts';
import { Ctx, Permissions } from '@los/nest-common';
import { z } from 'zod';
import { ZodValidationPipe } from '@los/nest-common';
import { SettingsService } from './settings.service';

const SetSettingBody = z.object({ value: z.unknown().refine((v) => v !== undefined, 'value is required'), reason: z.string().trim().max(2000).optional() });
type StatusRes = { status(code: number): unknown };

/** FR-13 · Тохиргоо. Унших — нэвтэрсэн бүх хэрэглэгч/сервис; өөрчлөх — `settings:manage` (ADMIN). Q-124: `FOUR_EYES_SETTING_KEYS` нь `reason`-той санал болж 202 (PENDING) / 201 (DIRECT) буцаана. */
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get() list(@Ctx() ctx: RequestContext) { return this.settings.list(ctx); }
  @Get(':key') get(@Ctx() ctx: RequestContext, @Param('key') key: string) { return this.settings.get(ctx, key); }

  @Permissions('settings:manage') @Put(':key')
  async set(@Ctx() ctx: RequestContext, @Param('key') key: string, @Body(new ZodValidationPipe(SetSettingBody)) body: z.infer<typeof SetSettingBody>, @Res({ passthrough: true }) res: StatusRes) {
    if (!isFourEyesSettingKey(key)) return this.settings.set(ctx, key, body.value);
    const r = await this.settings.propose(ctx, key, body.value, body.reason);
    res.status(r.outcome === 'PENDING' ? 202 : 201);
    return r;
  }
}
