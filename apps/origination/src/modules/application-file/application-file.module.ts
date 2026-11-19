import { Module } from '@nestjs/common';
import { createValuationPort, VALUATION_PORT } from '../collateral/ports/valuation.port';
import { DMS_DOCUMENTS } from '../document/dms-documents.port';
import { createDmsDocuments } from '../document/http-dms-documents.port';
import { ApplicationFileController } from './application-file.controller';
import { ApplicationFileService } from './application-file.service';
import { APPLICATION_FILE_STORE, HttpApplicationFileStore } from './application-file.store';

// Ажилтны файл татах (NFR-3): dms-ийн агуулгын замыг зөвхөн `svc:` хэрэглэгч татдаг тул ажилтан энд (хүсэлтийн хүрээ + файлын холбоос шалгасан) дамжина.
// PrismaService, ApplicationAccessService нь AppModule-аас. Тестэд `overrideProvider(DMS_DOCUMENTS | VALUATION_PORT | APPLICATION_FILE_STORE)`.
@Module({
  controllers: [ApplicationFileController],
  providers: [
    ApplicationFileService,
    { provide: DMS_DOCUMENTS, useFactory: () => createDmsDocuments() },
    { provide: VALUATION_PORT, useFactory: () => createValuationPort() },
    { provide: APPLICATION_FILE_STORE, useFactory: () => new HttpApplicationFileStore() },
  ],
})
export class ApplicationFileModule {}
