import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule, EventsModule, HealthModule, envFilePaths } from '@los/nest-common';
import { PrismaModule, PrismaService } from './prisma.service';
// Feature модуль бүр: өөрийн мөрийг `import` + `imports` хоёрт задлана (мөр тус бүр тусдаа тул зэрэгцээ салбар мерж хийхэд зөрчилгүй).
import { FileModule } from './modules/file/file.module';
import { OBJECT_STORAGE, type ObjectStorage } from './modules/file/storage';
import { EsignModule } from './modules/esign/esign.module';
// import { DocumentModule } from './modules/document/document.module';
// import { TemplateModule } from './modules/template/template.module';
// import { RetentionModule } from './modules/retention/retention.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: envFilePaths }),
    CommonModule.forRoot(),
    PrismaModule,
    EventsModule.forRoot({ schema: 'dms', db: PrismaService }),
    HealthModule.forServiceAsync({ service: 'dms', imports: [FileModule], inject: [PrismaService, OBJECT_STORAGE], useFactory: (db: PrismaService, storage: ObjectStorage) => ({ db: () => db.$queryRaw`SELECT 1`, storage: () => storage.ping() }) }),
    FileModule,
    // register() нь INTEGRATION_MODE зэрэг env-ийг ConfigModule.forRoot()-ийн ДАРАА уншина — дарааллыг бүү солих
    EsignModule.register(),
    // DocumentModule,
    // TemplateModule,
    // RetentionModule,
  ],
})
export class AppModule {}
