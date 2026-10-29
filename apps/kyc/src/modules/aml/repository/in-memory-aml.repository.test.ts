import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '@los/contracts';
import type { StoredScreening } from '../aml.ports';
import { describeAmlRepositoryContract } from './aml-repository.contract';
import { InMemoryAmlRepository } from './in-memory-aml.repository';

describeAmlRepositoryContract('in-memory', async () => {
  const repo = new InMemoryAmlRepository();
  return { repo, outbox: async () => repo.getOutbox() };
});

describe('InMemoryAmlRepository as a test double', () => {
  const screening: StoredScreening = {
    id: '00000000-0000-4000-8000-000000000001', orgId: 'org-1', customerId: 'cust-1', applicationId: null, trigger: 'MANUAL', status: 'CLEAR',
    blocking: false, riskScore: 0, riskLevel: 'LOW', riskFactors: [], subjectName: 'Test', registerNoMasked: 'УБ****5678', registerNoHash: 'h',
    registerNoEncrypted: 'e', subject: { subjectType: 'INDIVIDUAL', firstName: 'Test', aliases: [], countries: ['MN'], isPep: false, isRelatedParty: false },
    listVersions: {}, screenedAt: new Date('2026-03-01T00:00:00.000Z'), screenedBy: null, correlationId: 'c', hits: [],
  };
  const event: DomainEvent = {
    type: 'AmlScreeningCompleted', eventId: '00000000-0000-4000-8000-0000000000e1', occurredAt: '2026-03-01T00:00:00.000Z', version: 1, orgId: 'org-1',
    actorId: null, correlationId: 'c', screeningId: screening.id, customerId: 'cust-1', applicationId: null, status: 'CLEAR', blocking: false,
    riskScore: 0, riskLevel: 'LOW', hitCount: 0,
  };

  it('does not let callers change stored screenings through the objects they passed or received', async () => {
    const repo = new InMemoryAmlRepository();
    const input = structuredClone(screening);
    await repo.saveScreening(input, event);
    input.status = 'CONFIRMED_MATCH';
    const received = await repo.findScreening('org-1', screening.id);
    received!.blocking = true;
    expect(await repo.findScreening('org-1', screening.id)).toEqual(screening);
  });

  it('exposes the recorded outbox events in write order as copies', async () => {
    const repo = new InMemoryAmlRepository();
    await repo.saveScreening(screening, event);
    const outbox = repo.getOutbox();
    expect(outbox).toEqual([event]);
    outbox.pop();
    expect(repo.getOutbox()).toEqual([event]);
  });
});
