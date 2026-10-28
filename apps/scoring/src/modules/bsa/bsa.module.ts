// BSA (банкны хуулгын шинжилгээ) модулийн нэгдсэн Nest модуль: дэд бүтэц (common) + persistence + parser + OCR + ангилал + DTI дээр
// import pipeline, application service-үүд (шинжилгээ, upload, импорт, дахин тооцоолол, reclassify, finalize, retention) болон
// REST controller-уудыг (import/http, угтвар /api нь configureBsaApp-аар) угсарна.
//
// Lifecycle: ImportProcessor.onModuleInit → IMPORT_QUEUE.start (worker); RetentionService.onModuleInit → (BSA_RETENTION_INTERVAL_MS > 0 бол) таймер.
// Хаахдаа: IMPORT_QUEUE өөрийн onModuleDestroy-д явж буй ажлыг дуусгана. BsaCommonModule нь BsaPersistenceModule-ээс «гүн» (register({imports}))
// тул Nest-ийн destroy дараалалд queue ӨМНӨ хаагдаж, Prisma дараа салгагдана (ажил дундаа DB-гүй үлдэхгүй).
import { Module, type DynamicModule, type ModuleMetadata, type Type } from '@nestjs/common';
import { BsaCommonModule } from './common/bsa-common.module';
import { BsaPersistenceModule } from './common/persistence/persistence.module';
import { ClassifyModule } from './classify/classify.module';
import { DtiModule } from './dti/dti.module';
import { ParsersModule } from './parsers/parsers.module';
import { TextExtractionModule } from './parsers/text-extraction/text-extraction.module';
import { AnalysisService } from './import/analysis.service';
import { BsaAdminController, BsaAnalysesController, BsaCatalogController, BsaJobsController, BsaUploadInterceptor, RolesGuard } from './import/http';
import { FinalizeService } from './import/finalize.service';
import { BSA_CLOCK, BSA_IMPORT_OPTIONS, resolveImportOptions, SYSTEM_CLOCK } from './import/import.defaults';
import { ImportPipelineService } from './import/import-pipeline.service';
import { ImportProcessor } from './import/import.processor';
import { RecalculationService } from './import/recalculation.service';
import { ReclassifyService } from './import/reclassify.service';
import { RetentionService } from './import/retention.service';
import { NullSuspicionCounter, SUSPICION_COUNTER, type SuspicionCounter } from './import/suspicion.counter';
import { UploadService } from './import/upload.service';

const SERVICES = [
  AnalysisService,
  UploadService,
  ImportPipelineService,
  ImportProcessor,
  RecalculationService,
  ReclassifyService,
  FinalizeService,
  RetentionService,
];

const CONTROLLERS = [BsaAnalysesController, BsaJobsController, BsaCatalogController, BsaAdminController];

export interface BsaModuleOptions {
  /** Сэжигтэй гүйлгээний модуль `SuspicionCounter`-ээ энд өгнө (анхдагч: NullSuspicionCounter = 0) */
  suspicionCounter?: Type<SuspicionCounter>;
  /** Нэмэлт модуль (suspicionCounter-ийн хамаарал гэх мэт) */
  imports?: ModuleMetadata['imports'];
}

@Module({
  imports: [
    BsaCommonModule,
    BsaPersistenceModule.register({ imports: [BsaCommonModule] }),
    ParsersModule,
    TextExtractionModule,
    ClassifyModule,
    DtiModule,
  ],
  controllers: CONTROLLERS,
  providers: [
    ...SERVICES,
    RolesGuard,
    BsaUploadInterceptor,
    { provide: BSA_IMPORT_OPTIONS, useFactory: () => resolveImportOptions(process.env) },
    { provide: BSA_CLOCK, useValue: SYSTEM_CLOCK },
    { provide: SUSPICION_COUNTER, useClass: NullSuspicionCounter },
  ],
  exports: [...SERVICES, SUSPICION_COUNTER],
})
export class BsaModule {
  /** Анхдагчаас ялгаатай хэсэг (жишээ нь бодит SuspicionCounter) өгөх. Динамик providers статикийг дарж бичнэ */
  static register(options: BsaModuleOptions = {}): DynamicModule {
    return {
      module: BsaModule,
      imports: options.imports ?? [],
      providers: options.suspicionCounter ? [{ provide: SUSPICION_COUNTER, useClass: options.suspicionCounter }] : [],
    };
  }
}
