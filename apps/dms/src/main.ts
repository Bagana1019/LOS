import { bootstrapService } from '@los/nest-common';
import { AppModule } from './app.module';

void bootstrapService({ service: 'dms', module: AppModule, portEnv: 'DMS_PORT', defaultPort: 4005 });
