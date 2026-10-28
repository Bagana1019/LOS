import { bootstrapService } from '@los/nest-common';
import { AppModule } from './app.module';

void bootstrapService({ service: 'origination', module: AppModule, portEnv: 'ORIGINATION_PORT', defaultPort: 4001 });
