import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule, type Provider } from '@nestjs/common';
import { noStoreMiddleware } from './common/no-store.middleware';
import { assertIntegrationSafe, isProduction, loadPosConfig, PosConfigError, POS_CONFIG, readIntegrationMode, type IntegrationMode } from './config/pos.config';
import { MerchantPortalController } from './controllers/merchant-portal.controller';
import { MerchantsController } from './controllers/merchants.controller';
import { PosLeasesController } from './controllers/pos-leases.controller';
import { PosPlansController } from './controllers/pos-plans.controller';
import { DemoPiiCipher } from './integrations/demo-pii-cipher';
import { integrationProviders } from './integrations/integration.providers';
import { PiiCipher } from './ports';
import { LeaseRepository, MerchantRepository, OtpRepository, PlanRepository } from './persistence/repositories';
import { createInMemoryPersistence } from './persistence/memory/in-memory';
import { prismaPersistenceProviders } from './persistence/prisma/prisma-persistence.providers';
import { DashboardService } from './services/dashboard.service';
import { LeaseService } from './services/lease.service';
import { MerchantService } from './services/merchant.service';
import { OtpService } from './services/otp.service';
import { PlanService } from './services/plan.service';
import { QuoteService } from './services/quote.service';

/** Тест/demo-д outbox-ийг (санах ойн persistence) унших DI token. */
export const IN_MEMORY_OUTBOX = Symbol('IN_MEMORY_OUTBOX');

export interface MerchantModuleOptions {
  /** `prisma` (анхдагч) | `memory` (тест/demo; production-д хориотой) */
  persistence?: 'prisma' | 'memory';
  /** Сүүлд бүртгэгдэж ижил token-той provider-ыг дарна (тестэд Clock, IdGenerator, BuyerScreeningPort …) */
  overrides?: Provider[];
  /** Анхдагч: INTEGRATION_MODE env */
  integrationMode?: IntegrationMode;
}

const SERVICES = [OtpService, PlanService, QuoteService, MerchantService, LeaseService, DashboardService];
const CONTROLLERS = [MerchantPortalController, MerchantsController, PosPlansController, PosLeasesController];

@Module({})
export class MerchantModule implements NestModule {
  /** Merchant API-ийн бүх route-д `Cache-Control: no-store` (PII-тэй хариу кэшлэгдэхгүй). Зөвхөн энэ модулийн controller-ууд — аппын бусад route-д нөлөөлөхгүй. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(noStoreMiddleware).forRoutes(...CONTROLLERS);
  }

  static register(opts: MerchantModuleOptions = {}): DynamicModule {
    const persistence = opts.persistence ?? 'prisma';
    if (persistence === 'memory' && isProduction()) {
      throw new PosConfigError('MerchantModule: in-memory persistence is forbidden when NODE_ENV=production');
    }
    // Provider-ыг ЖИНХЭНЭЭР сонгох горим. Production guard-ыг env биш энэ горимоор шалгана (register({ integrationMode: 'mock' }) production-д нэвтрэхгүй),
    // мөн POS_CONFIG-д ижил горимыг дамжуулна → config ба provider-ууд зөрөхгүй.
    const mode = opts.integrationMode ?? readIntegrationMode();
    assertIntegrationSafe({ nodeEnv: process.env.NODE_ENV ?? '', integrationMode: mode });
    if (isProduction() && opts.overrides?.length) {
      throw new PosConfigError('MerchantModule: provider overrides are forbidden when NODE_ENV=production (they could replace OTP/screening/SMS safeguards)');
    }

    const persistenceProviders: Provider[] = [];
    if (persistence === 'memory') {
      const mem = createInMemoryPersistence();
      persistenceProviders.push(
        { provide: MerchantRepository, useValue: mem.merchants },
        { provide: PlanRepository, useValue: mem.plans },
        { provide: LeaseRepository, useValue: mem.leases },
        { provide: OtpRepository, useValue: mem.otps },
        { provide: IN_MEMORY_OUTBOX, useValue: mem.outbox },
        { provide: PiiCipher, useClass: DemoPiiCipher }, // DEMO ONLY — зөвхөн санах ойн persistence-тэй
      );
    } else {
      persistenceProviders.push(...prismaPersistenceProviders);
    }

    return {
      module: MerchantModule,
      controllers: CONTROLLERS,
      providers: [
        // POS-sec: production + горим≠real → register() дээр аль хэдийн алдаа шидсэн; энд real горимын нууц/URL-ийн шалгалт (module init).
        { provide: POS_CONFIG, useFactory: () => loadPosConfig(process.env, mode) },
        ...integrationProviders(mode),
        ...persistenceProviders,
        ...SERVICES,
        ...(opts.overrides ?? []),
      ],
      exports: [...SERVICES, POS_CONFIG, MerchantRepository, PlanRepository, LeaseRepository, OtpRepository, PiiCipher],
    };
  }
}
