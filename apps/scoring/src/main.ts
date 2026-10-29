import { bootstrapService } from '@los/nest-common';
import { AppModule } from './app.module';
import { configureBsaApp } from './modules/bsa/import/http';

// Угтвар /api, JSON лог, graceful shutdown — bootstrapService. BSA: нэгдсэн алдааны filter (монгол мессеж, code), X-Correlation-Id, JSON body 1 MB.
// Хуулгын файл multipart-аар орно: хязгаар нь BsaUploadInterceptor + BsaSettings (maxUploadBytes, maxFilesPerUpload).
void bootstrapService({ service: 'scoring', module: AppModule, portEnv: 'SCORING_PORT', defaultPort: 4003, configure: (app) => configureBsaApp(app) });
