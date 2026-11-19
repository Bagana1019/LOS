import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CommonModule, HealthModule, envFilePaths } from '@los/nest-common';
import { AdminModule } from './modules/admin/admin.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { DirectoryModule } from './modules/directory/directory.module';
import { PaymentCallbacksModule } from './modules/payment-callbacks/payment-callbacks.module';
import { ProxyModule } from './modules/proxy/proxy.module';
import { PublicEsignModule } from './modules/public-esign/public-esign.module';
import { RateLimitModule, SharedCounterStore } from './modules/rate-limit/rate-limit.module';
import { PrismaModule, PrismaService } from './prisma.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: envFilePaths }),
    // Глобал хязгаар (IP тутам минутад 600); нэвтрэх endpoint-д илүү чанга (@Throttle). M9: тоолуур Redis-д — бүх pod нэг хязгаар.
    RateLimitModule,
    ThrottlerModule.forRootAsync({
      inject: [SharedCounterStore],
      useFactory: (counters: SharedCounterStore) => ({ throttlers: [{ name: 'default', ttl: 60_000, limit: 600 }], storage: counters.throttlerStorage() }),
    }),
    CommonModule.forRoot({ contextGuard: false, trustIdentityHeaders: false }),
    PrismaModule,
    HealthModule.forServiceAsync({ service: 'gateway', inject: [PrismaService], useFactory: (db: PrismaService) => ({ db: () => db.$queryRaw`SELECT 1` }) }),
    AdminModule,
    AuditModule,
    AuthModule,
    DirectoryModule,
    PaymentCallbacksModule, // H9: ProxyModule-оос ӨМНӨ (route дараалал)
    ProxyModule,
    PublicEsignModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
