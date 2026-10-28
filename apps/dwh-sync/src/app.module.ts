import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
// import { EtlModule } from './modules/etl/etl.module';
// import { ConsumersModule } from './modules/consumers/consumers.module';
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true })], controllers: [HealthController] })
export class AppModule {}
