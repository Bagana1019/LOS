import { Controller, Get, Inject, Module, ServiceUnavailableException, type DynamicModule } from '@nestjs/common';
import { Public } from '../auth/guards';

export type HealthCheck = () => Promise<unknown>;
export interface HealthOptions { service: string; checks: Record<string, HealthCheck> }
const HEALTH_OPTIONS = Symbol('HEALTH_OPTIONS');
const CHECK_TIMEOUT_MS = 2000;

const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), CHECK_TIMEOUT_MS).unref())]);

@Controller('health')
class HealthController {
  constructor(@Inject(HEALTH_OPTIONS) private readonly opts: HealthOptions) {}

  /** AC: GET /api/health → 200 (liveness; хамаарал шалгахгүй). */
  @Public() @Get()
  health() { return { service: this.opts.service, ok: true, time: new Date().toISOString() }; }

  /** Readiness: DB/Redis гэх мэт хамаарал. Аль нэг нь унавал 503. */
  @Public() @Get('ready')
  async ready() {
    const checks: Record<string, 'up' | 'down'> = {};
    await Promise.all(Object.entries(this.opts.checks).map(async ([name, fn]) => {
      try { await withTimeout(fn()); checks[name] = 'up'; } catch { checks[name] = 'down'; }
    }));
    const ok = Object.values(checks).every((c) => c === 'up');
    const body = { service: this.opts.service, ok, checks };
    if (!ok) throw new ServiceUnavailableException(body);
    return body;
  }
}

@Module({})
export class HealthModule {
  static forService(service: string, checks: Record<string, HealthCheck> = {}): DynamicModule {
    return { module: HealthModule, controllers: [HealthController], providers: [{ provide: HEALTH_OPTIONS, useValue: { service, checks } satisfies HealthOptions }] };
  }
}
