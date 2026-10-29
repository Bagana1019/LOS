import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED, encryptedField } from '@los/database';
import { PrismaService } from '../../prisma.service';
import { PHONE, REGISTER_AAD, seedBorrower, seedContract } from './contract-db.fixtures';
import { silenceLogs } from './contract-signing.fixtures';
import { PrismaApplicationSigningLookup } from './prisma-application-signing-lookup';

silenceLogs();

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const db = new PrismaService();
const lookup = new PrismaApplicationSigningLookup(db);
const newId = () => `app-${crypto.randomUUID()}`;

beforeAll(async () => { if (HAS_DB) await db.$connect(); });
afterAll(async () => { if (HAS_DB) await db.$disconnect(); });

describe.skipIf(!HAS_DB)('PrismaApplicationSigningLookup', () => {
  it('хүсэлт + үндсэн зээлдэгчийн (регистрийг тайлж) мэдээллийг буцаана', async () => {
    const id = newId();
    await seedContract(db, { applicationId: id, contractNo: 'B10026102801' });
    const customerId = await seedBorrower(db, id);

    const found = await lookup.getForSigning(SEED.org.id, id);
    expect(found).toMatchObject({
      orgId: SEED.org.id, applicationId: id, officerId: SEED.users.officerA.id, branchId: SEED.branches.head.id, status: 'APPROVED', contractNo: 'B10026102801',
      primaryBorrower: { customerId, fullName: 'Бат-Эрдэнэ Болд', phone: PHONE },
    });
    expect(found!.primaryBorrower!.registerNo).toMatch(/^УА\d{8}$/);
  });

  it('өөр байгууллага эсвэл байхгүй хүсэлт → null', async () => {
    const id = newId();
    await seedContract(db, { applicationId: id });
    expect(await lookup.getForSigning('00000000-0000-4000-8000-0000000000ff', id)).toBeNull();
    expect(await lookup.getForSigning(SEED.org.id, newId())).toBeNull();
  });

  it('is_primary биш зээлдэгчийг (хамтран) авахгүй → primaryBorrower null', async () => {
    const id = newId();
    await seedContract(db, { applicationId: id });
    await seedBorrower(db, id, { isPrimary: false });
    expect((await lookup.getForSigning(SEED.org.id, id))!.primaryBorrower).toBeNull();
  });

  it('регистрийг AAD-гүй шифрлэсэн (customer модуль AAD тавиагүй) ч уншина; утас шифрлэгдсэн бол тайлна', async () => {
    const id = newId();
    await seedContract(db, { applicationId: id });
    await seedBorrower(db, id, { registerNoEncrypted: encryptedField('УА99887766'), phone: encryptedField('88001122', 'customer.phone') });
    expect((await lookup.getForSigning(SEED.org.id, id))!.primaryBorrower).toMatchObject({ registerNo: 'УА99887766', phone: '88001122' });
  });

  it('тайлж чадахгүй регистр (өөр AAD-аар түгжсэн) → primaryBorrower null, PII логлохгүй', async () => {
    const id = newId();
    await seedContract(db, { applicationId: id });
    await seedBorrower(db, id, { registerNoEncrypted: encryptedField('УА12345678', 'other.column') });
    expect((await lookup.getForSigning(SEED.org.id, id))!.primaryBorrower).toBeNull();
  });

  it('утасгүй зээлдэгч → phone хоосон (service 409 өгнө)', async () => {
    const id = newId();
    await seedContract(db, { applicationId: id });
    await seedBorrower(db, id, { phone: null });
    expect((await lookup.getForSigning(SEED.org.id, id))!.primaryBorrower).toMatchObject({ phone: '' });
  });

  it('ЗЭЗ-гүй ("Систем") хүсэлт: officerId null', async () => {
    const id = newId();
    await seedContract(db, { applicationId: id, officerId: null });
    expect((await lookup.getForSigning(SEED.org.id, id))!.officerId).toBeNull();
  });

  it('REGISTER_AAD нь docs-д тодорхойлсон нэр', () => {
    expect(REGISTER_AAD).toBe('customer.register_no');
  });
});
