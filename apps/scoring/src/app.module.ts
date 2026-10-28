import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule, EventsModule, HealthModule, envFilePaths } from '@los/nest-common';
import { PrismaModule, PrismaService } from './prisma.service';
// Feature модуль бүр: өөрийн мөрийг `import` + `imports` хоёрт задлана (мөр тус бүр тусдаа тул зэрэгцээ салбар мерж хийхэд зөрчилгүй).
// import { UnderwritingModule } from './modules/underwriting/underwriting.module';
// import { SoscoModule } from './modules/sosco/sosco.module';
// import { ImportModule } from './modules/bsa/import/import.module';
// import { ClassifyModule } from './modules/bsa/classify/classify.module';
// import { DtiModule } from './modules/bsa/dti/dti.module';
// import { SuspicionModule } from './modules/bsa/suspicion/suspicion.module';
// import { ParsersModule } from './modules/bsa/parsers/parsers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: envFilePaths }),
    CommonModule.forRoot(),
    PrismaModule,
    EventsModule.forRoot({ schema: 'scoring', db: PrismaService }),
    HealthModule.forServiceAsync({ service: 'scoring', inject: [PrismaService], useFactory: (db: PrismaService) => ({ db: () => db.$queryRaw`SELECT 1` }) }),
    // UnderwritingModule,
    // SoscoModule,
    // ImportModule,
    // ClassifyModule,
    // DtiModule,
    // SuspicionModule,
    // ParsersModule,
  ],
})
export class AppModule {}
