import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule, EventsModule, HealthModule, envFilePaths } from '@los/nest-common';
import { PrismaModule, PrismaService } from './prisma.service';
// Feature модуль бүр: өөрийн мөрийг `import` + `imports` хоёрт задлана (мөр тус бүр тусдаа тул зэрэгцээ салбар мерж хийхэд зөрчилгүй).
// import { FileModule } from './modules/file/file.module';
// import { DocumentModule } from './modules/document/document.module';
// import { TemplateModule } from './modules/template/template.module';
// import { RetentionModule } from './modules/retention/retention.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: envFilePaths }),
    CommonModule.forRoot(),
    PrismaModule,
    EventsModule.forRoot({ schema: 'dms', db: PrismaService }),
    HealthModule.forServiceAsync({ service: 'dms', inject: [PrismaService], useFactory: (db: PrismaService) => ({ db: () => db.$queryRaw`SELECT 1` }) }),
    // FileModule,
    // DocumentModule,
    // TemplateModule,
    // RetentionModule,
  ],
})
export class AppModule {}
