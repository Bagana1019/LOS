// BSA persistence-ийн нийтийн гадаргуу. Prisma-д ХАМААРАХГҮЙ (generated client шаардахгүй) → pipeline/controller-ийн unit тест
// эндээс port + InMemoryBsaRepository-г ашиглана. PostgreSQL хэрэгжүүлэлт (PrismaBsaRepository, PrismaService, BsaPersistenceModule)-ийг
// app module `./persistence.module`-оос шууд импортлоно.
export * from './bsa.repository';
export { InMemoryBsaRepository, type InMemoryBsaRepositoryOptions } from './memory-bsa.repository';
export { accountKeyOf, buildDedupeKeys, type DedupeRow } from './dedupe-key';
export { normalizeAccount, normalizeRegisterNo, mergeAccounts, roundMoney } from './bsa.validation';
