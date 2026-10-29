// InMemoryBsaRepository: гэрээний тест + in-memory-д онцгой шинж (хуулбар буцаах, snapshot rollback).
import { describe, expect, it } from 'vitest';
import { InMemoryBsaRepository } from './memory-bsa.repository';
import { describeRepositoryContract, type RepositoryHarness } from './repository.contract';

async function memoryHarness(): Promise<RepositoryHarness> {
  let now = new Date(0);
  let current = new InMemoryBsaRepository({ now: () => now });
  const harness: RepositoryHarness = {
    get repo() {
      return current;
    },
    async reset() {
      current = new InMemoryBsaRepository({ now: () => now });
    },
    async seedConfig(orgId, cfg) {
      current.seedConfig(orgId, cfg);
    },
    setNow(d) {
      now = d;
    },
    async close() {},
  };
  return harness;
}

describeRepositoryContract('InMemoryBsaRepository', memoryHarness);

describe('InMemoryBsaRepository specifics', () => {
  it('returns copies: mutating a result does not change stored state', async () => {
    const repo = new InMemoryBsaRepository();
    const a = await repo.analyses.create({ orgId: 'o', applicationId: 'a', customerId: 'c', ownAccounts: ['X1'] });
    a.ownAccounts.push('HACK');
    a.status = 'ANALYZED';
    expect(await repo.analyses.getById(a.id)).toMatchObject({ status: 'DRAFT', ownAccounts: ['X1'] });
  });

  it('serializes transactions: a failed one cannot roll back a concurrent successful one', async () => {
    const repo = new InMemoryBsaRepository();
    const slowFail = repo.runInTransaction(async (tx) => {
      await tx.analyses.create({ orgId: 'o', applicationId: 'fail', customerId: 'c' });
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('boom');
    });
    const ok = repo.runInTransaction(async (tx) => (await tx.analyses.create({ orgId: 'o', applicationId: 'ok', customerId: 'c' })).id);
    await expect(slowFail).rejects.toThrow('boom');
    const id = await ok;
    expect(await repo.analyses.getById(id)).not.toBeNull();
    expect((await repo.analyses.list({ orgId: 'o' })).items.map((a) => a.applicationId)).toEqual(['ok']);
  });
});
