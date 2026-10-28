import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule, EventsModule, HealthModule, envFilePaths } from '@los/nest-common';
import { PrismaModule, PrismaService } from './prisma.service';
// Feature модуль бүр: өөрийн мөрийг `import` + `imports` хоёрт задлана (мөр тус бүр тусдаа тул зэрэгцээ салбар мерж хийхэд зөрчилгүй).
// import { InquiryModule } from './modules/inquiry/inquiry.module';
// import { XypModule } from './modules/xyp/xyp.module';
// import { DanModule } from './modules/dan/dan.module';
// import { CibModule } from './modules/cib/cib.module';
// import { NdshModule } from './modules/ndsh/ndsh.module';
// import { AmlModule } from './modules/aml/aml.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: envFilePaths }),
    CommonModule.forRoot(),
    PrismaModule,
    EventsModule.forRoot({ schema: 'kyc', db: PrismaService }),
    HealthModule.forServiceAsync({ service: 'kyc', inject: [PrismaService], useFactory: (db: PrismaService) => ({ db: () => db.$queryRaw`SELECT 1` }) }),
    // InquiryModule,
    // XypModule,
    // DanModule,
    // CibModule,
    // NdshModule,
    // AmlModule,
  ],
})
export class AppModule {}
