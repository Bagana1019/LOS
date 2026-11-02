import { Module } from '@nestjs/common';
import { CustomerDirectory } from '../borrower/customer-directory';
import { DMS_DOCUMENTS } from './dms-documents.port';
import { DocumentController } from './document.controller';
import { DocumentEventsSubscriber } from './document-events.subscriber';
import { ApplicationDocumentService } from './document.service';
import { createDmsDocuments } from './http-dms-documents.port';

// Модуль 9 (FR-9.1, FR-9.2): хүсэлтийн баримт бичиг, product.document_checklist_json-оор checklist, 8-р алхам. dms-ийн `document`-ийг sync дууддаг (`DMS_DOCUMENTS` порт).
// PrismaService, ApplicationAccessService (SharedModule), Clock (CommonModule), EVENT_BUS (EventsModule) нь AppModule-аас; e2e тест DMS_DOCUMENTS-ийг fake-ээр солино.
@Module({
  controllers: [DocumentController],
  providers: [
    ApplicationDocumentService,
    DocumentEventsSubscriber,
    CustomerDirectory,
    { provide: DMS_DOCUMENTS, useFactory: () => createDmsDocuments() },
  ],
  exports: [ApplicationDocumentService],
})
export class DocumentModule {}
