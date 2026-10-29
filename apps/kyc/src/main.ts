import { bootstrapService } from '@los/nest-common';
import { AppModule } from './app.module';

void bootstrapService({ service: 'kyc', module: AppModule, portEnv: 'KYC_PORT', defaultPort: 4002 });
