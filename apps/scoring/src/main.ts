import { bootstrapService } from '@los/nest-common';
import { AppModule } from './app.module';

void bootstrapService({ service: 'scoring', module: AppModule, portEnv: 'SCORING_PORT', defaultPort: 4003 });
