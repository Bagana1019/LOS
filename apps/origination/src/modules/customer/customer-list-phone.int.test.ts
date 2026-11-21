import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { blindIndex, encryptedField } from '@los/database';
import type { RequestContext } from '@los/contracts';
import { PrismaService } from '../../prisma.service';
import type { BlacklistLookupService } from '../blacklist/blacklist-lookup.service';
import { CustomerService } from './customer.service';
import type { XypLookup } from './xyp-lookup';

// F1-2 · FR-2.2: хайлтын утасны нэр томьёо хадгалахтай ижил normalizePhone-оор цэвэрлэгдэнэ ("9911 2233", "+976 9911-2233" → 99112233).
// Бодит Postgres шаардана (TEST_DATABASE_URL). Тест бүр өөрийн orgId-тай тул хүснэгт цэвэрлэхгүй.
describe.skipIf(!process.env.TEST_DATABASE_URL)('CustomerService.list · утасны хайлт (F1-2)', () => {
  const prisma = new PrismaService();
  const noBlacklist = { blacklistedHashes: async () => new Set<string>() } as unknown as BlacklistLookupService;
  const service = new CustomerService(prisma, noBlacklist, {} as XypLookup);
  let orgId: string;
  let ids: { byPhone: string; other: string; noPhone: string };

  afterAll(async () => { await prisma.$disconnect(); });

  const ctx = () => ({ orgId } as unknown as RequestContext);
  const search = async (q: string) => (await service.list(ctx(), { q, page: 1, pageSize: 20 })).items.map((i) => i.id);
  const seed = async (registerNo: string, firstName: string, phone: string | null) =>
    (await prisma.customer.create({ data: { orgId, registerNoHash: blindIndex(registerNo), registerNoEncrypted: encryptedField(registerNo), customerType: 'INDIVIDUAL', firstName, phone } })).id;

  beforeEach(async () => {
    orgId = `org-${randomUUID()}`;
    ids = { byPhone: await seed('УБ90010112', 'Сарнай', '99112233'), other: await seed('УБ91010211', 'Болд', '88001122'), noPhone: await seed('УБ92010312', 'Төгс', null) };
  });

  it.each([
    ['spaces', '9911 2233'],
    ['dashes', '9911-2233'],
    ['+976 prefix with spaces and dash', '+976 9911-2233'],
    ['976 prefix', '976 99112233'],
    ['surrounding spaces', '  99112233  '],
    ['parentheses and dots', '(9911).2233'],
  ])('finds the customer when the phone term has %s', async (_label, term) => {
    expect(await search(term)).toEqual([ids.byPhone]);
  });

  it('a partial term still matches after the separators are stripped', async () => {
    expect(await search('99 11')).toEqual([ids.byPhone]);
    expect(await search('9911')).toEqual([ids.byPhone]);
  });

  it('a term that is only separators does not match every customer that has a phone', async () => {
    expect(await search('---')).toEqual([]);
  });

  it('name and register search are unchanged by the phone normalisation', async () => {
    expect(await search('Сарн')).toEqual([ids.byPhone]);
    expect(await search('УБ91010211')).toEqual([ids.other]);
  });
});
