import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { customerTypeOfRegister, normalizeRegisterNo, type BlacklistWarning, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { z } from 'zod';
import { BlacklistLookupService } from './blacklist-lookup.service';

const CheckQuery = z.object({ registerNo: z.string().trim().min(1, 'Регистр оруулна уу').max(32) });

@Controller('blacklist')
export class BlacklistController {
  constructor(private readonly lookup: BlacklistLookupService) {}

  /** Регистрээр шалгах (маягтад регистр бичих үед автомат). 200 + анхааруулгын жагсаалт (хоосон = цэвэр). */
  @Permissions('blacklist:read') @Get('check')
  async check(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(CheckQuery)) q: z.infer<typeof CheckQuery>): Promise<{ registerNo: string; blacklisted: boolean; warnings: BlacklistWarning[] }> {
    const norm = normalizeRegisterNo(q.registerNo);
    if (!customerTypeOfRegister(norm)) throw new BadRequestException({ code: 'INVALID_REGISTER_NO', message: 'Регистрийн дугаар буруу (иргэн УБ12345678, байгууллага 7 орон)' });
    const warnings = await this.lookup.warningsForRegisterNo(ctx.orgId, norm);
    return { registerNo: norm, blacklisted: warnings.length > 0, warnings };
  }
}
