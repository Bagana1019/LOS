import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { BlacklistEntryChanged } from '@los/contracts';
import type { EventBus } from '@los/database';
import { EVENT_BUS } from '@los/nest-common';
import { AML_REPOSITORY, type AmlRepository, type ProjectionResult } from './aml.ports';

/**
 * origination.blacklist → kyc.blacklist_projection (CLAUDE.md §3.2.3: cross-schema FK-гүй, event-ээр read model).
 * `los:events`-ийн BlacklistEntryChanged-ийг consumer group `kyc`-ээр сонсоно (EventsModule өгсөн EVENT_BUS; Redis тохируулаагүй бол bus null — тэр үед зөвхөн `handle`-ийг шууд дуудна).
 */
@Injectable()
export class BlacklistProjectionService implements OnModuleInit {
  constructor(
    @Inject(AML_REPOSITORY) private readonly repo: AmlRepository,
    @Optional() @Inject(EVENT_BUS) private readonly bus: EventBus | null = null,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.bus?.subscribe('kyc', ['BlacklistEntryChanged'], async (event) => { await this.handle(event); });
  }

  /** Idempotent: eventId давхцвал DUPLICATE, хуучин changedAt бол STALE (хэрэгжүүлэлт repository-д). */
  async handle(raw: unknown): Promise<ProjectionResult> {
    const e = BlacklistEntryChanged.parse(raw);
    return this.repo.applyBlacklistProjection(
      {
        id: e.entryId,
        orgId: e.orgId,
        registerNoHash: e.registerNoHash,
        customerType: e.customerType,
        name: e.name,
        listType: e.listType,
        reasonCode: e.reasonCode,
        isActive: e.isActive,
        changedAt: new Date(e.changedAt),
      },
      e.eventId,
    );
  }
}
