import { Inject, Injectable } from '@nestjs/common';
import { BlacklistEntryChanged } from '@los/contracts';
import { AML_REPOSITORY, type AmlRepository, type ProjectionResult } from './aml.ports';

/**
 * origination.blacklist → kyc.blacklist_projection (CLAUDE.md §3.2.3: cross-schema FK-гүй, event-ээр read model).
 * Event bus (@los/database createRedisEventBus) бэлэн болоход `los:events`-ийн BlacklistEntryChanged-ийг энд дамжуулна.
 */
@Injectable()
export class BlacklistProjectionService {
  constructor(@Inject(AML_REPOSITORY) private readonly repo: AmlRepository) {}

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
