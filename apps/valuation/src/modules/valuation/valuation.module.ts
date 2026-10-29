import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { AutoValuationService } from './auto-valuation.service';
import { DemoValuationSettings } from './demo-valuation-settings';
import { ValuationController } from './valuation.controller';
import { VALUATION_SETTINGS } from './valuation-settings.port';

// Needs CommonModule (Clock, request context, error filter, auth guard) and ConfigModule from the AppModule.
@Module({
  imports: [IntegrationsModule],
  controllers: [ValuationController],
  providers: [AutoValuationService, { provide: VALUATION_SETTINGS, useClass: DemoValuationSettings }],
})
export class ValuationModule {}
