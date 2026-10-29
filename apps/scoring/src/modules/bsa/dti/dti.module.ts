// BSA DTI-ийн Nest модуль: aggregate + computeBsaDti. Stateless, хамаарал байхгүй.
import { Module } from '@nestjs/common';
import { DtiAnalysisService } from './dti-analysis.service';

@Module({
  providers: [DtiAnalysisService],
  exports: [DtiAnalysisService],
})
export class DtiModule {}
