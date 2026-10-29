import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuditModule } from './audit/audit.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { PortalConfigModule } from './config/config.module';
import { HealthController } from './health.controller';
import { IntegrationsModule } from './integrations/integrations.module';
import { AuthModule } from './modules/auth/auth.module';
import { CustomerAuthGuard } from './modules/auth/auth.guard';
import { ContractModule } from './modules/contract/contract.module';
import { LoansModule } from './modules/loans/loans.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RateLimitGuard } from './security/rate-limit.guard';
import { SecurityModule } from './security/security.module';
import { StoreModule } from './store/store.module';

@Module({
  imports: [PortalConfigModule, StoreModule, AuditModule, SecurityModule, IntegrationsModule, AuthModule, LoansModule, ContractModule, PaymentsModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    // Дараалал чухал: эхлээд нэвтрэлт (principal), дараа нь per-customer rate limit
    { provide: APP_GUARD, useClass: CustomerAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
