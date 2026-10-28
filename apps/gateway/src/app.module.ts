import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CommonModule, HealthModule, envFilePaths } from '@los/nest-common';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/jwt-auth.guard';
import { ProxyModule } from './modules/proxy/proxy.module';
import { PrismaModule, PrismaService } from './prisma.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: envFilePaths }),
    // Глобал хязгаар (IP тутам минутад 600); нэвтрэх endpoint-д илүү чанга (@Throttle)
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 600 }]),
    CommonModule.forRoot({ contextGuard: false, trustIdentityHeaders: false }),
    PrismaModule,
    HealthModule.forServiceAsync({ service: 'gateway', inject: [PrismaService], useFactory: (db: PrismaService) => ({ db: () => db.$queryRaw`SELECT 1` }) }),
    AuditModule,
    AuthModule,
    ProxyModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
