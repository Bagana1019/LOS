// FR-11.4 e2e БОДИТ Postgres-тэй (storage=memory): HTTP → SigningService → PrismaSigningStore (транзакц, partial unique index, outbox) → dms.file.
// TEST_DATABASE_URL тавигдсан үед л ажиллана (apps/dms/test/setup-env.ts), үгүй бол алгасна. Тест бүр өмнө/дараа нь өөрийн мөрүүдийг устгана (`E2E_ORG`).
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyE2eEnv, E2E_ORG, OFFICER, providerRefFrom, signWebhook, startE2e, tokenFrom, type E2e,
} from './testing/e2e-app';

const hasDatabase = !!process.env.TEST_DATABASE_URL;
const TIMEOUT = 60_000;
const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

describe.skipIf(!hasDatabase)('e2e Postgres: HTTP → PrismaSigningStore', () => {
  let restoreEnv: () => void;
  let e2e: E2e;
  beforeAll(() => {
    restoreEnv = applyE2eEnv();
  });
  afterAll(() => restoreEnv());
  beforeEach(async () => {
    e2e = await startE2e({ database: true });
  });
  afterEach(() => e2e.close());

  const sign = (token: string, rest = ''): string => `/api/public/esign/${token}${rest}`;
  const staff = (id: string, rest = ''): string => `/api/esign/requests/${id}${rest}`;
  async function inProgress() {
    const { id, token } = await e2e.issue();
    expect((await e2e.getBinary(sign(token, '/document'))).status).toBe(200);
    const started = await e2e.post(sign(token, '/start'), { provider: 'TRIDUM', consent: true, consentVersion: 'v1' });
    expect(started.status).toBe(200);
    return { id, token, providerRef: providerRefFrom(started.body.deepLink) };
  }

  it('бүтэн урсгал: create → view → start → approve → SIGNED → татах → verify; DB-д PII шифрлэгдсэн, токен hash-аар', { timeout: TIMEOUT }, async () => {
    const created = await e2e.createRequest();
    expect(created.status).toBe(201);
    const id: string = created.body.id;
    const token = tokenFrom(created.body.signingUrl);

    expect((await e2e.get(sign(token))).body).toMatchObject({ status: 'PENDING', documentViewed: false });
    expect((await e2e.getBinary(sign(token, '/document'))).status).toBe(200);
    const started = await e2e.post(sign(token, '/start'), { provider: 'MONPASS', consent: true, consentVersion: 'v1' });
    expect(started.body).toMatchObject({ status: 'IN_PROGRESS', provider: 'MONPASS' });
    expect((await e2e.post(`/api/dev/esign/mock/${providerRefFrom(started.body.deepLink)}/approve`)).status).toBe(200);
    const signed = await e2e.get(sign(token, '/status'));
    expect(signed.body).toMatchObject({ status: 'SIGNED', provider: 'MONPASS', signedDocumentAvailable: true });

    const download = await e2e.getBinary(sign(token, '/signed-document'));
    expect(download.status).toBe(200);
    const verified = await e2e.get(`/api/public/esign/verify/${signed.body.verificationCode}`);
    expect(verified.body).toMatchObject({ valid: true, provider: 'MONPASS', signedSha256: sha256(download.body), originalSha256: sha256(e2e.sourcePdf) });

    // Ажилтны харагдац + жагсаалт Postgres-оос
    expect((await e2e.get(staff(id))).body).toMatchObject({ id, status: 'SIGNED', verificationCode: signed.body.verificationCode });
    const staffPdf = await e2e.getBinary(staff(id, '/signed-document'), OFFICER);
    expect(Buffer.compare(staffPdf.body, download.body)).toBe(0);
    expect((await e2e.get('/api/esign/requests?applicationId=app-1')).body.map((view: { id: string }) => view.id)).toEqual([id]);

    // DB: регистр/утас шифрлэгдсэн, токен хадгалагдаагүй (зөвхөн hash)
    const [row] = await e2e.prisma.$queryRaw<Array<{ register: string; phone: string; token_hash: string; signed_file_id: string; signature_file_id: string }>>`
      SELECT signer_register_encrypted AS register, signer_phone_encrypted AS phone, token_hash, signed_file_id, signature_file_id FROM dms.signing_request WHERE id = ${id}::uuid`;
    expect(row.register).toMatch(/^v1\./);
    expect(row.phone).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toMatch(/УА12345633|99112233/);
    expect(row.token_hash).toBe(sha256(token));
    const files = await e2e.prisma.file.findMany({ where: { id: { in: [row.signed_file_id, row.signature_file_id] } } });
    expect(files.map((file) => file.mime).sort()).toEqual(['application/pdf', 'application/pkcs7-signature']);
    expect(files.find((file) => file.mime === 'application/pdf')?.sha256).toBe(sha256(download.body));

    // Outbox + audit (нэг транзакцид бичигдсэн)
    const events = await e2e.events();
    expect(events.map((event) => event.type)).toEqual(['ContractSigningRequested', 'ContractSigned']);
    expect(events[1]).toMatchObject({ signingRequestId: id, provider: 'MONPASS', signedSha256: sha256(download.body) });
    const audit = (await e2e.store.listAudit(id)).map((entry) => entry.type);
    expect(audit).toEqual(expect.arrayContaining(['CREATED', 'DOCUMENT_VIEWED', 'CONSENT_GIVEN', 'PROVIDER_SESSION_STARTED', 'SIGNED', 'SIGNED_DOWNLOADED']));
    expect(JSON.stringify(await e2e.store.listAudit(id))).not.toMatch(/УА12345633|99112233/);
  });

  it('нэг гэрээнд идэвхтэй хүсэлт ганц: дараачийнх 409; supersede → хуучин CANCELLED', async () => {
    const first = await e2e.issue();
    const conflict = await e2e.createRequest();
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'SIGNING_CONFLICT', reason: 'ACTIVE_EXISTS' });
    const second = await e2e.createRequest({ supersedeActive: true });
    expect(second.status).toBe(201);
    expect((await e2e.get(staff(first.id))).body.status).toBe('CANCELLED');
  });

  it('зэрэгцээ create: DB-ийн partial unique index тул яг нэг нь 201, бусад нь 409 (500 биш)', async () => {
    const replies = await Promise.all(Array.from({ length: 5 }, () => e2e.createRequest()));
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect((await e2e.get('/api/esign/requests?applicationId=app-1')).body).toHaveLength(1);
  });

  it('зэрэгцээ poll + webhook: ContractSigned яг нэг, файл нэг багц, бүх хариу амжилттай', { timeout: TIMEOUT }, async () => {
    const { id, token, providerRef } = await inProgress();
    await e2e.post(`/api/dev/esign/mock/${providerRef}/approve`);
    const body = JSON.stringify({ providerRef });
    const hook = () => e2e.post('/api/public/esign/callback/tridum', body, { 'content-type': 'application/json', 'x-mock-signature': signWebhook(body) });

    const replies = await Promise.all([e2e.get(sign(token, '/status')), hook(), e2e.get(sign(token, '/status')), hook(), e2e.get(sign(token, '/status'))]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([200, 200, 200, 204, 204]);

    expect((await e2e.get(staff(id))).body.status).toBe('SIGNED');
    expect((await e2e.events()).filter((event) => event.type === 'ContractSigned')).toHaveLength(1);
    expect((await e2e.store.listAudit(id)).filter((entry) => entry.type === 'SIGNED')).toHaveLength(1);
  });

  it('хугацаа дууссан хүсэлтийг sweeper хаана; төгсгөлийн төлөвт шинэ хүсэлт үүсгэж болно', async () => {
    const { id } = await e2e.issue({ ttlHours: 1 });
    e2e.clock.advanceHours(2);
    await e2e.sweeper.tick();
    expect((await e2e.get(staff(id))).body).toMatchObject({ status: 'EXPIRED', failureReason: 'EXPIRED' });
    expect((await e2e.createRequest()).status).toBe(201);
    expect((await e2e.events()).map((event) => event.type)).toEqual(['ContractSigningRequested', 'ContractSigningFailed', 'ContractSigningRequested']);
  });

  it('uuid биш id → 404 (DB руу хүрэхгүй); үл мэдэгдэх uuid → 404; байгууллагын мөр устсан', async () => {
    expect((await e2e.get(staff('not-a-uuid'))).status).toBe(404);
    expect((await e2e.get(staff('2f8c1c0e-1b57-4d0e-9a53-2a0c4b9b6a11'))).status).toBe(404);
    expect(await e2e.prisma.signingRequest.count({ where: { orgId: E2E_ORG } })).toBe(0);
  });
});
