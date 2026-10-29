import { bootstrapService } from '@los/nest-common';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

void bootstrapService({ service: 'valuation', module: AppModule, portEnv: 'VALUATION_PORT', defaultPort: 4004, configure: configureApp });
