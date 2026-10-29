import type { Provider } from '@nestjs/common';
import { CryptoIdGenerator } from '../common/ids';
import { SystemClock } from '../common/time';
import { POS_CONFIG, type IntegrationMode, type PosConfig } from '../config/pos.config';
import { BuyerScreeningPort, Clock, IdGenerator, OtpGenerator, PricingProvider, SmsGateway } from '../ports';
import { FixedOtpGenerator } from './otp/fixed-otp.generator';
import { RandomOtpGenerator } from './otp/random-otp.generator';
import { PlanPricingProvider } from './pricing/plan-pricing.provider';
import { HttpBuyerScreening } from './screening/http-buyer-screening';
import { MockBuyerScreening } from './screening/mock-buyer-screening';
import { MockSmsGateway } from './sms/mock-sms.gateway';
import { RealSmsGateway } from './sms/real-sms.gateway';

/** INTEGRATION_MODE-оор mock/real сонгоно (CLAUDE.md §3.2.7, docs/05 §11). */
export function integrationProviders(mode: IntegrationMode): Provider[] {
  const common: Provider[] = [
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: CryptoIdGenerator },
    { provide: PricingProvider, useClass: PlanPricingProvider },
  ];
  if (mode === 'real') {
    return [
      ...common,
      { provide: BuyerScreeningPort, useFactory: (cfg: PosConfig) => new HttpBuyerScreening({ baseUrl: cfg.kycBaseUrl }), inject: [POS_CONFIG] },
      { provide: SmsGateway, useClass: RealSmsGateway },
      { provide: OtpGenerator, useClass: RandomOtpGenerator },
    ];
  }
  return [
    ...common,
    { provide: BuyerScreeningPort, useFactory: (clock: Clock) => new MockBuyerScreening(clock), inject: [Clock] },
    { provide: SmsGateway, useClass: MockSmsGateway },
    { provide: OtpGenerator, useClass: FixedOtpGenerator },
  ];
}
