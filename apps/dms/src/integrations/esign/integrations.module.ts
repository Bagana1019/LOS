// FR-11.4 Provider-ийн интеграцийн модуль. INTEGRATION_MODE=mock|real (default mock; NODE_ENV=production-д mock → эхлэхэд алдаа).
// Экспорт: ESIGN_PROVIDERS, CLOCK, ProviderRegistry. Нэг процесст ЯГ НЭГ удаа import хийнэ — mock session-ий төлөв provider instance-д байдаг.
// Анхаар: register() нь env-ийг дуудагдсан үедээ (decorator үнэлэгдэх үед) уншина — .env-ийг ConfigModule.forRoot() ачаалдаг бол
// түүний ДАРАА (AppModule imports-д) дуудна, эсвэл env нь process-д урьдаас тавигдсан байх ёстой.
import { Module, type DynamicModule } from '@nestjs/common';
import { MockMonpassProvider } from '../monpass/monpass.mock';
import { RealMonpassProvider } from '../monpass/monpass.real';
import { MockTridumProvider } from '../tridum/tridum.mock';
import { RealTridumProvider } from '../tridum/tridum.real';
import { DevMockEsignController } from './dev-mock.controller';
import { CLOCK, ESIGN_PROVIDERS, type Clock, type ESignProviderPort } from './esign-provider.port';
import { loadIntegrationsConfig, type IntegrationsConfig } from './integrations.config';
import { ProviderRegistry } from './provider.registry';

export const systemClock: Clock = () => new Date();

export interface IntegrationsModuleOptions {
  /** Default: process.env */
  env?: Readonly<Record<string, string | undefined>>;
  /** Default: системийн цаг (тестэд инжектлэнэ) */
  clock?: Clock;
}

function buildProviders(config: IntegrationsConfig, env: Readonly<Record<string, string | undefined>>, clock: Clock): ESignProviderPort[] {
  if (config.mode === 'real') return [new RealTridumProvider(env), new RealMonpassProvider(env)];
  const options = { clock, approveAfterMs: config.approveAfterMs, webhookSecret: config.webhookSecret };
  return [new MockTridumProvider(options), new MockMonpassProvider(options)];
}

@Module({})
export class IntegrationsModule {
  static register(options: IntegrationsModuleOptions = {}): DynamicModule {
    const env = options.env ?? process.env;
    const clock = options.clock ?? systemClock;
    const config = loadIntegrationsConfig(env);
    // Dev endpoint: production-д mock аль хэдийн алдаа өгдөг; энд дахин шалгах нь хамгаалалтын давхар хаалт
    const exposeDevEndpoints = config.mode === 'mock' && env.NODE_ENV !== 'production';
    return {
      module: IntegrationsModule,
      controllers: exposeDevEndpoints ? [DevMockEsignController] : [],
      providers: [
        { provide: CLOCK, useValue: clock },
        { provide: ESIGN_PROVIDERS, useValue: buildProviders(config, env, clock) },
        ProviderRegistry,
      ],
      exports: [ESIGN_PROVIDERS, CLOCK, ProviderRegistry],
    };
  }
}
