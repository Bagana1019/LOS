import { runErpEventRepositoryContract } from './erp-event.repository.contract';
import type { ErpEventRepository } from './erp-event.repository';
import { MemoryErpEventRepository } from './testing/memory-erp-event.repository';

// The in-memory double has no reset(); the harness forwards every call to a current instance that reset() replaces.
runErpEventRepositoryContract('in-memory', async () => {
  let current = new MemoryErpEventRepository();
  const repo: ErpEventRepository = {
    insert: (draft, tx) => current.insert(draft, tx),
    claimNext: (args) => current.claimNext(args),
    complete: (args) => current.complete(args),
    getById: (id) => current.getById(id),
    list: (filter) => current.list(filter),
    stats: (orgId) => current.stats(orgId),
    requeue: (id, actorId, note, now) => current.requeue(id, actorId, note, now),
    cancel: (id, actorId, note, now) => current.cancel(id, actorId, note, now),
  };
  return {
    repo,
    reset: async () => { current = new MemoryErpEventRepository(); },
    close: async () => undefined,
  };
});
