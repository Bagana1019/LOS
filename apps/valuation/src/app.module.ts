import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
import { ValuationModule } from './modules/valuation/valuation.module';
// import { BasePriceModule } from './modules/base-price/base-price.module';
// import { HaircutModule } from './modules/haircut/haircut.module';
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), ValuationModule], controllers: [HealthController] })
export class AppModule {}
