import { Module } from '@nestjs/common';
import { PaymentCallbackRateLimitGuard } from './payment-callback-rate-limit.guard';
import { PaymentCallbackForwarder, PaymentCallbacksController } from './payment-callbacks.controller';

/** H9 — провайдерын callback (JWT-гүй). AppModule-д ProxyModule-оос ӨМНӨ бүртгэнэ: Express эхэнд таарсан route-ийг сонгоно. */
@Module({ controllers: [PaymentCallbacksController], providers: [PaymentCallbackForwarder, PaymentCallbackRateLimitGuard] })
export class PaymentCallbacksModule {}
