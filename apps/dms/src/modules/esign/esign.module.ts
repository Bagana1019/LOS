// FR-11.4 E-sign модуль: HTTP (дотоод + public), SigningService, sweeper ба тэдгээрийн хамаарал (store, файл, штамп, cipher, provider-ууд).
// Ашиглах: AppModule-ийн `imports`-д `ConfigModule.forRoot()`-ийн ДАРАА `EsignModule.register()` — INTEGRATION_MODE / MOCK_ESIGN_* / TRIDUM_* / MONPASS_*-ийг
// энэ дуудлага уншдаг (integrations.module.ts), `.env` ачаалагдсаны дараа байх ёстой. Бусад env (ESIGN_*) апп босох үед provider factory-д уншигдана.
// Хамаарал: глобал PrismaModule (PrismaService), CommonModule (auth guard, Clock), FileModule (OBJECT_STORAGE).
import { Module, RequestMethod, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Clock } from '../../integrations/esign/esign-provider.port';
import { IntegrationsModule } from '../../integrations/esign/integrations.module';
import { fieldCipherProvider, signingFilesProvider } from './adapters/adapter.providers';
import { FileModule } from '../file/file.module';
import { esignConfigProvider } from './esign.config';
import { EsignController } from './http/esign.controller';
import { PublicEsignController } from './http/public-esign.controller';
import { applyNoStore } from './http/no-store';
import { PdfLibStamper } from './pdf/pdf-lib-stamper';
import { PDF_STAMPER } from './ports/pdf-stamper.port';
import { SigningSweeperService } from './signing-sweeper.service';
import { SigningService } from './signing.service';
import { signingStoreProvider } from './stores/signing-store.provider';

export interface EsignModuleOptions {
  /** Тестэд: mock provider-ууд болон SigningService-ийн цаг. Default: системийн цаг */
  clock?: Clock;
}

@Module({})
export class EsignModule implements NestModule {
  /** Токен/гэрээ/гарын үсгийн хариу (танигдаагүй зам, алдаа ч) браузер/proxy-д кэшлэгдэхгүй, MIME sniff хийгдэхгүй */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply((_req: Request, res: Response, next: () => void) => { applyNoStore(res); next(); })
      .forRoutes({ path: 'public/esign/*', method: RequestMethod.ALL }, { path: 'esign/*', method: RequestMethod.ALL });
  }

  static register(options: EsignModuleOptions = {}): DynamicModule {
    return {
      module: EsignModule,
      imports: [ConfigModule, FileModule, IntegrationsModule.register({ clock: options.clock })],
      controllers: [EsignController, PublicEsignController],
      providers: [
        esignConfigProvider,
        fieldCipherProvider,
        signingStoreProvider,
        signingFilesProvider,
        { provide: PDF_STAMPER, useClass: PdfLibStamper },
        SigningService,
        SigningSweeperService,
      ],
      exports: [SigningService],
    };
  }
}
