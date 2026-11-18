import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { createCounterStore, type CounterStore, type CounterStoreHandle } from './counter-store';
import { CounterThrottlerStorage } from './throttler.storage';

/** Gateway-ийн бүх pod-д нийтлэг тоолуур (M9). Түлхүүрийн угтвар: RATE_LIMIT_KEY_PREFIX (анхдагч `los:gateway:rl:`). */
@Injectable()
export class SharedCounterStore implements OnModuleDestroy {
  private readonly handle: CounterStoreHandle = createCounterStore();
  readonly prefix = process.env.RATE_LIMIT_KEY_PREFIX?.trim() || 'los:gateway:rl:';
  get store(): CounterStore { return this.handle.store; }
  throttlerStorage(): CounterThrottlerStorage { return new CounterThrottlerStorage(this.store, this.prefix); }
  async onModuleDestroy() { await this.handle.close(); }
}

@Global()
@Module({ providers: [SharedCounterStore], exports: [SharedCounterStore] })
export class RateLimitModule {}
