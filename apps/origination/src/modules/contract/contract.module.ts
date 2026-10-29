import { Module } from '@nestjs/common';
import { APPLICATION_SIGNING_LOOKUP } from './application-signing-lookup';
import { ContractEventsSubscriber } from './contract-events.subscriber';
import { ContractSigningController } from './contract-signing.controller';
import { ContractSigningEventHandler } from './contract-signing.event-handler';
import { ContractSigningService } from './contract-signing.service';
import { CONTRACT_REPOSITORY } from './contract.repository';
import { ESIGN_GATEWAY } from './esign.gateway';
import { createDmsEsignGateway } from './http-dms-esign.gateway';
import { PrismaApplicationSigningLookup } from './prisma-application-signing-lookup';
import { PrismaContractRepository } from './prisma-contract.repository';
import { createSigningLinkNotifier, SIGNING_LINK_NOTIFIER } from './signing-link-notifier';

// FR-11.4 Цахим гарын үсэг (origination тал). Гэрээ үүсгэх (generated_file_id), цаасан гарын үсэг (скан) нь Module 9/11-ийн ажил.
// PrismaService (global PrismaModule), EVENT_BUS (EventsModule), Clock (CommonModule) нь AppModule-аас.
@Module({
  controllers: [ContractSigningController],
  providers: [
    ContractSigningService,
    ContractSigningEventHandler,
    ContractEventsSubscriber,
    { provide: APPLICATION_SIGNING_LOOKUP, useClass: PrismaApplicationSigningLookup },
    { provide: CONTRACT_REPOSITORY, useClass: PrismaContractRepository },
    { provide: ESIGN_GATEWAY, useFactory: () => createDmsEsignGateway() },
    // TODO(M13): бодит SMS adapter-ыг notification модулиас холбоно
    { provide: SIGNING_LINK_NOTIFIER, useFactory: () => createSigningLinkNotifier() },
  ],
  // G4 олголтын хаалга (disbursement модуль) contract.signed_file_id-ийг эндээс уншина
  exports: [CONTRACT_REPOSITORY],
})
export class ContractModule {}
