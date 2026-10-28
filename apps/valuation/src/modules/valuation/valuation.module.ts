import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { CLOCK, systemClock } from '../../common/clock';
import { correlationIdMiddleware } from '../../common/correlation-id';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { AutoValuationService } from './auto-valuation.service';
import { DemoValuationSettings } from './demo-valuation-settings';
import { ValuationController } from './valuation.controller';
import { VALUATION_SETTINGS } from './valuation-settings.port';

@Module({
  imports: [IntegrationsModule],
  controllers: [ValuationController],
  providers: [
    AutoValuationService,
    { provide: VALUATION_SETTINGS, useClass: DemoValuationSettings },
    { provide: CLOCK, useValue: systemClock },
  ],
})
export class ValuationModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationIdMiddleware).forRoutes(ValuationController);
  }
}
