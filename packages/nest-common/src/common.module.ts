import { type DynamicModule, Global, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Clock, SystemClock } from './clock';
import { ContextAuthGuard } from './auth/guards';
import { REQUEST_CONTEXT_OPTIONS, RequestContextMiddleware } from './context/request-context';
import { AllExceptionsFilter } from './http/errors';

export interface CommonModuleOptions {
  /** Gateway өөрөө JWT-ээр нэвтрүүлдэг тул `false`. Бусад сервис `true` (анхдагч). */
  contextGuard?: boolean;
  /** Gateway: `false` — identity толгойг хүлээн авахгүй (JWT guard тавина). Анхдагч `true`. */
  trustIdentityHeaders?: boolean;
}

/** Сервис бүрийн AppModule-д: `CommonModule.forRoot()`. Контекст middleware, алдааны фильтр, guard, Clock. */
@Global()
@Module({})
export class CommonModule implements NestModule {
  static forRoot(opts: CommonModuleOptions = {}): DynamicModule {
    const guard = opts.contextGuard ?? true;
    return {
      module: CommonModule,
      providers: [
        { provide: REQUEST_CONTEXT_OPTIONS, useValue: { trustIdentityHeaders: opts.trustIdentityHeaders ?? true } },
        { provide: Clock, useClass: SystemClock },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        ...(guard ? [{ provide: APP_GUARD, useClass: ContextAuthGuard }] : []),
      ],
      exports: [Clock],
    };
  }
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
