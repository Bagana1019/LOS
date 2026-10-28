import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
// import { AuthModule } from './modules/auth/auth.module';
// import { ProxyModule } from './modules/proxy/proxy.module';
// import { AuditModule } from './modules/audit/audit.module';
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true })], controllers: [HealthController] })
export class AppModule {}
