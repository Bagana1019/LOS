import { createInMemoryPersistence } from './memory/in-memory';
import { describeRepositoryContract } from './repository.contract';

// Эталон хэрэгжүүлэлт: санах ойн repository нь Prisma-тай ижил contract-ыг давах ёстой (үргэлж ажиллана, DB шаардахгүй).
describeRepositoryContract('in-memory', () => {
  const p = createInMemoryPersistence();
  return {
    merchants: p.merchants,
    plans: p.plans,
    leases: p.leases,
    otps: p.otps,
    readOutbox: async () => structuredClone(p.outbox.events),
    reset: async () => undefined, // factory тест бүрт шинэ instance үүсгэдэг
  };
});
