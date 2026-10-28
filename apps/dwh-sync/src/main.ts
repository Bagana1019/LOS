import { bootstrapService } from '@los/nest-common';
import { AppModule } from './app.module';

void bootstrapService({ service: 'dwh-sync', module: AppModule, portEnv: 'DWH_SYNC_PORT', defaultPort: 4006 });
