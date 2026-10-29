import { bootstrapService } from '@los/nest-common';
import { AppModule } from './app.module';
import { configureGateway } from './configure';

void bootstrapService({
  service: 'gateway',
  module: AppModule,
  portEnv: 'GATEWAY_PORT',
  defaultPort: 4000,
  cors: { origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim()), credentials: true },
  bodyParser: false,
  configure: configureGateway,
});
