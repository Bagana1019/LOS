// BSA-BR-8: хадгалах хугацаа (settings.retentionYears) дууссан шинжилгээг гараар устгах. Үндсэн арга: BSA_RETENTION_INTERVAL_MS таймер.
import { Body, Controller, HttpCode, Inject, Logger, Post, UseGuards } from '@nestjs/common';
import { BsaRetentionRunRequest } from '@los/contracts';
import { Ctx, RequestContextGuard } from '../../common/request-context';
import type { RequestContext } from '../../common/infra.ports';
import { RetentionService, type RetentionReport } from '../retention.service';
import { ADMIN_ONLY, Roles, RolesGuard } from './roles';
import { orEmpty } from './schemas';
import { ZodValidationPipe } from './zod-validation.pipe';

@Controller('bsa/admin')
@UseGuards(RequestContextGuard, RolesGuard)
export class BsaAdminController {
  private readonly log = new Logger(BsaAdminController.name);

  constructor(@Inject(RetentionService) private readonly retention: RetentionService) {}

  /** Хугацаа хэтэрсэн шинжилгээг (хамгийн ихдээ `limit`, анхдагч — тохиргооны багц) DB-ээс устгаад дараа нь файлуудыг устгана */
  @Post('retention/run')
  @HttpCode(200)
  @Roles(...ADMIN_ONLY)
  async runRetention(
    @Ctx() ctx: RequestContext,
    @Body(new ZodValidationPipe(orEmpty(BsaRetentionRunRequest))) body: BsaRetentionRunRequest,
  ): Promise<RetentionReport> {
    const report = await this.retention.purgeExpired(undefined, body.limit);
    // Устсан шинжилгээний аудит өөрөө устдаг тул үйлдлийг лог дээр тоогоор үлдээнэ (хэн, хэдийг)
    this.log.log(`retention run by ${ctx.userId}: examined=${report.examined} purged=${report.purged} objectsDeleted=${report.objectsDeleted} objectFailures=${report.objectFailures}`);
    return report;
  }
}
