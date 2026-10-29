import { Module } from '@nestjs/common';
import { ERP_GATEWAY, createErpGateway, parseErpEnv } from '../../integrations/erp';
import { ERP_SYNC_CONFIG, loadErpSyncConfig } from './erp-sync.config';
import { ErpSyncController } from './erp-sync.controller';
import { ErpSyncService } from './erp-sync.service';
import { ERP_EVENT_REPOSITORY } from './erp-event.repository';
import { PrismaErpEventRepository } from './erp-event.prisma-repository';
import { OutboxRelayService } from './outbox-relay.service';

// FIN-SYNC: олголт / шимтгэл суутгал / эргэн төлөлтийн үйл явдлыг ERP руу outbox-оор найдвартай дамжуулна (журналыг ERP өөрөө бичнэ).
// Бусад модуль энэ module-ийг import хийж ErpSyncService.emit*()-ийг дуудна.
@Module({
  controllers: [ErpSyncController],
  providers: [
    ErpSyncService, OutboxRelayService,
    { provide: ERP_SYNC_CONFIG, useFactory: () => loadErpSyncConfig(process.env) },
    { provide: ERP_GATEWAY, useFactory: () => createErpGateway(parseErpEnv(process.env)) },
    { provide: ERP_EVENT_REPOSITORY, useClass: PrismaErpEventRepository },
  ],
  exports: [ErpSyncService],
})
export class ErpSyncModule {}
