import { bootstrapService } from '@los/nest-common';
import { AppModule } from './app.module';

// rawBody: provider webhook-ийн HMAC-ийг илгээсэн БАЙТААР шалгана (modules/esign/http/public-esign.controller.ts)
void bootstrapService({ service: 'dms', module: AppModule, portEnv: 'DMS_PORT', defaultPort: 4005, rawBody: true });
