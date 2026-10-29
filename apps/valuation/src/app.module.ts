import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule, EventsModule, HealthModule, envFilePaths } from '@los/nest-common';
import { PrismaModule, PrismaService } from './prisma.service';
// Feature модуль бүр: өөрийн мөрийг `import` + `imports` хоёрт задлана (мөр тус бүр тусдаа тул зэрэгцээ салбар мерж хийхэд зөрчилгүй).
import { ValuationModule } from './modules/valuation/valuation.module';
// import { BasePriceModule } from './modules/base-price/base-price.module';
// import { HaircutModule } from './modules/haircut/haircut.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: envFilePaths }),
    CommonModule.forRoot(),
    PrismaModule,
    EventsModule.forRoot({ schema: 'valuation', db: PrismaService }),
    HealthModule.forServiceAsync({ service: 'valuation', inject: [PrismaService], useFactory: (db: PrismaService) => ({ db: () => db.$queryRaw`SELECT 1` }) }),
    ValuationModule,
    // BasePriceModule,
    // HaircutModule,
  ],
})
export class AppModule {}
