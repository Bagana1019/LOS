// BSA ангиллын Nest модуль. Stateless тул хамаарал байхгүй; DtiModule / import pipeline эндээс ClassifierService авна.
import { Module } from '@nestjs/common';
import { ClassifierService } from './classify.service';

@Module({
  providers: [ClassifierService],
  exports: [ClassifierService],
})
export class ClassifyModule {}
