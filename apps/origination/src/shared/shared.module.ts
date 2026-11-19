import { Global, Module } from '@nestjs/common';
import { SettingsModule } from '../modules/settings/settings.module';
import { ApplicationAccessService } from './application-access.service';
import { DomainEvents } from './domain-events';
import { ORG_DIRECTORY_SOURCE, OrgDirectoryService, createOrgDirectorySource } from './org-directory';
import { OrgSettings } from './org-settings';

/** Borrower / payment / notification / report модулиудын хуваалцдаг жижиг үйлчилгээ (Clock, Prisma, guard, error filter нь `@los/nest-common`-оос). */
@Global()
@Module({
  imports: [SettingsModule],
  providers: [DomainEvents, OrgSettings, ApplicationAccessService, { provide: ORG_DIRECTORY_SOURCE, useFactory: () => createOrgDirectorySource() }, OrgDirectoryService],
  exports: [DomainEvents, OrgSettings, ApplicationAccessService, OrgDirectoryService],
})
export class SharedModule {}
