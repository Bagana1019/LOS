import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { customerTypeOfRegister, normalizeRegisterNo, type BlacklistWarning, type RequestContext } from '@los/contracts';
import { Ctx, Permissions } from '@los/nest-common';
import { BlacklistLookupService } from './blacklist-lookup.service';

@Controller('blacklist')
export class BlacklistController {
  constructor(private readonly lookup: BlacklistLookupService) {}

  /** Регистрээр шалгах (маягтад регистр бичих үед автомат). 200 + анхааруулгын жагсаалт (хоосон = цэвэр). */
  @Permissions('blacklist:read') @Get('check')
  async check(@Ctx() ctx: RequestContext, @Query('registerNo') registerNo?: string): Promise<{ registerNo: string; blacklisted: boolean; warnings: BlacklistWarning[] }> {
    const norm = normalizeRegisterNo(registerNo ?? '');
    if (!customerTypeOfRegister(norm)) throw new BadRequestException({ code: 'INVALID_REGISTER_NO', message: 'Регистрийн дугаар буруу (иргэн УБ12345678, байгууллага 7 орон)' });
    const warnings = await this.lookup.warningsForRegisterNo(ctx.orgId, norm);
    return { registerNo: norm, blacklisted: warnings.length > 0, warnings };
  }
}
