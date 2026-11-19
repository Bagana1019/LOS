import { Module } from '@nestjs/common';
import { FileModule } from '../file/file.module';
import { RetentionService } from './retention.service';
import { RetentionSweeper } from './retention.sweeper';

/** M10: retention_policy-оор хугацаа дууссан файлыг устгах sweeper. PrismaService нь AppModule-аас (global). */
@Module({
  imports: [FileModule],
  providers: [RetentionService, RetentionSweeper],
  exports: [RetentionService],
})
export class RetentionModule {}
