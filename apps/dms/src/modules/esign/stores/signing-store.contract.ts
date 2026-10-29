// SigningStore-ын гэрээний тест (contract test): MemorySigningStore болон PrismaSigningStore ИЖИЛ семантиктай гэдгийг
// нэг дор баталгаажуулна. `signingStoreContract(label, harness)`-ийг store бүрийн *.test.ts дуудна.
import { randomBytes, randomUUID } from 'node:crypto';
import type { DomainEvent } from '@los/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock, SignerCertificate } from '../../../integrations/esign/esign-provider.port';
import type { NewSigningRequest, SigningAuditEntry, SigningRequestRecord, SigningStore } from '../ports/signing.store';
import { ActiveSigningExistsError, SigningConstraintError, SigningRequestNotFoundError, SigningUniqueViolationError } from './errors';

/** Тестийн мөр/event бүр энэ org-д — Prisma harness зөвхөн үүнийг цэвэрлэнэ (dev өгөгдөл хөндөгдөхгүй) */
export const CONTRACT_TEST_ORG = 'store-contract-test';

export interface OutboxRow { id: string; type: string; payload: unknown }

export interface SigningStoreHarness {
  store: SigningStore;
  /** Тестийн org-ийн outbox мөрүүд (дараалал баталгаагүй) */
  outbox(): Promise<OutboxRow[]>;
}

export interface SigningStoreContractOptions {
  create(clock: Clock): SigningStoreHarness | Promise<SigningStoreHarness>;
  /** Тест бүрийн дараа тестийн өгөгдлийг цэвэрлэнэ */
  cleanup?(): Promise<void>;
}

export interface TestClock { clock: Clock; set(at: Date): void; advance(ms: number): void; now(): Date }

export function createTestClock(start = new Date('2026-10-28T10:00:00.000Z')): TestClock {
  let current = start.getTime();
  return {
    clock: () => new Date(current),
    set: (at) => { current = at.getTime(); },
    advance: (ms) => { current += ms; },
    now: () => new Date(current),
  };
}

export function newRequest(overrides: Partial<NewSigningRequest> = {}): NewSigningRequest {
  return {
    id: randomUUID(),
    orgId: CONTRACT_TEST_ORG,
    applicationId: `app-${randomUUID()}`,
    contractId: `contract-${randomUUID()}`,
    contractNo: 'ГЭР-2026-000123',
    sourceFileId: randomUUID(),
    originalSha256: 'a'.repeat(64),
    signerCustomerId: 'cust-1',
    signerName: 'Бат-Эрдэнэ Болд',
    signerRegisterEnc: 'v1:test-register',
    signerPhoneEnc: 'v1:test-phone',
    signerRegisterMasked: 'УА****5678',
    signerPhoneMasked: '+976 ****2233',
    tokenHash: randomBytes(32).toString('hex'),
    linkExpiresAt: new Date('2026-10-31T10:00:00.000Z'),
    correlationId: 'corr-1',
    createdBy: 'officer-1',
    ...overrides,
  };
}

export function certificate(overrides: Partial<SignerCertificate> = {}): SignerCertificate {
  return {
    subjectName: 'БОЛД БАТ-ЭРДЭНЭ',
    subjectRegisterNo: 'УА12345678',
    issuer: 'LOS MOCK CA (ТЕСТ)',
    serialNumber: '0A1B2C3D',
    notBefore: new Date('2026-01-01T00:00:00.000Z'),
    notAfter: new Date('2028-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

export function requestedEvent(record: Pick<SigningRequestRecord, 'id' | 'applicationId' | 'contractId' | 'contractNo'>, overrides: { eventId?: string } = {}): DomainEvent {
  return {
    type: 'ContractSigningRequested',
    eventId: overrides.eventId ?? randomUUID(),
    occurredAt: '2026-10-28T10:00:00.000Z',
    version: 1,
    orgId: CONTRACT_TEST_ORG,
    actorId: null,
    correlationId: 'corr-1',
    signingRequestId: record.id,
    applicationId: record.applicationId,
    contractId: record.contractId,
    contractNo: record.contractNo,
    linkExpiresAt: '2026-10-31T10:00:00.000Z',
  };
}

export function audit(type: SigningAuditEntry['type'], at: Date, extra: Partial<SigningAuditEntry> = {}): SigningAuditEntry {
  return { type, actor: 'SYSTEM', at, ...extra };
}

export function signedPatch(overrides: Partial<SigningRequestRecord> = {}): Partial<SigningRequestRecord> {
  return {
    status: 'SIGNED',
    provider: 'TRIDUM',
    providerRef: `TRD-MOCK-${randomUUID()}`,
    signedFileId: randomUUID(),
    signatureFileId: randomUUID(),
    signedSha256: 'b'.repeat(64),
    verificationCode: randomBytes(6).toString('hex').toUpperCase(),
    signedAt: new Date('2026-10-28T11:00:00.000Z'),
    certificate: certificate(),
    providerTxnId: 'txn-1',
    providerMock: true,
    ...overrides,
  };
}

export function signingStoreContract(label: string, options: SigningStoreContractOptions): void {
  describe(`SigningStore contract: ${label}`, () => {
    let store: SigningStore;
    let outbox: () => Promise<OutboxRow[]>;
    let time: TestClock;

    beforeEach(async () => {
      time = createTestClock();
      const harness = await options.create(time.clock);
      store = harness.store;
      outbox = harness.outbox;
    });
    afterEach(async () => {
      await options.cleanup?.();
    });

    describe('create', () => {
      it('PENDING төлөвтэй, attempts 0, бусад талбар null, цаг нь clock-оос үүснэ', async () => {
        const input = newRequest();
        const created = await store.create(input);
        expect(created).toEqual({
          ...input,
          status: 'PENDING',
          provider: null,
          providerRef: null,
          challengeCode: null,
          deepLink: null,
          sessionExpiresAt: null,
          signedFileId: null,
          signatureFileId: null,
          signedSha256: null,
          verificationCode: null,
          documentViewedAt: null,
          consentAt: null,
          attempts: 0,
          certificate: null,
          providerTxnId: null,
          providerMock: false,
          failureReason: null,
          failureDetail: null,
          createdAt: time.now(),
          updatedAt: time.now(),
          signedAt: null,
        });
        expect(await store.getById(input.id)).toEqual(created);
      });

      it('мөр + аудит + outbox нэг дор бичигдэнэ (outbox.id = eventId, payload = event)', async () => {
        const input = newRequest();
        const event = requestedEvent(input);
        await store.create(input, { audit: [audit('CREATED', time.now(), { actor: 'officer-1', ip: '10.0.0.1', detail: { channel: 'web' } })], events: [event] });

        expect(await store.listAudit(input.id)).toEqual([
          { type: 'CREATED', actor: 'officer-1', at: time.now(), ip: '10.0.0.1', userAgent: null, detail: { channel: 'web' } },
        ]);
        expect(await outbox()).toEqual([{ id: event.eventId, type: 'ContractSigningRequested', payload: event }]);
      });

      it('нэг гэрээнд хоёр дахь идэвхтэй хүсэлт → ActiveSigningExistsError, юу ч бичигдэхгүй', async () => {
        const first = await store.create(newRequest());
        const duplicate = newRequest({ contractId: first.contractId, applicationId: first.applicationId });
        const event = requestedEvent(duplicate);

        const error = await store.create(duplicate, { audit: [audit('CREATED', time.now())], events: [event] }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ActiveSigningExistsError);
        expect((error as ActiveSigningExistsError).contractId).toBe(first.contractId);
        expect(await store.getById(duplicate.id)).toBeNull();
        expect(await store.listAudit(duplicate.id)).toEqual([]);
        expect(await outbox()).toEqual([]);
        expect(await store.listByApplication(first.applicationId)).toHaveLength(1);
      });

      it('идэвхтэй хүсэлт төгсгөлийн төлөвт орсны дараа шинийг үүсгэж болно; түүх хадгалагдана, шинэ нь түрүүлж', async () => {
        const first = await store.create(newRequest());
        time.advance(1000);
        await store.transition(first.id, ['PENDING'], { status: 'CANCELLED', failureReason: 'CANCELLED' });
        time.advance(1000);
        const second = await store.create(newRequest({ contractId: first.contractId, applicationId: first.applicationId }));

        expect((await store.findActiveByContract(first.contractId))?.id).toBe(second.id);
        expect((await store.listByApplication(first.applicationId)).map((r) => r.id)).toEqual([second.id, first.id]);
      });

      it('нэг гэрээнд зэрэгцээ хоёр create: яг нэг нь ялж, нөгөө нь ActiveSigningExistsError (аудит/event үлдэхгүй)', async () => {
        const contractId = `contract-${randomUUID()}`;
        const inputs = [newRequest({ contractId }), newRequest({ contractId })];

        const results = await Promise.allSettled(inputs.map((input) => store.create(input, { audit: [audit('CREATED', time.now())], events: [requestedEvent(input)] })));

        const fulfilled = results.filter((r): r is PromiseFulfilledResult<SigningRequestRecord> => r.status === 'fulfilled');
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(ActiveSigningExistsError);
        const loser = inputs.find((input) => input.id !== fulfilled[0].value.id);
        expect(await store.getById(loser?.id ?? '')).toBeNull();
        expect(await store.listAudit(loser?.id ?? '')).toEqual([]);
        expect(await outbox()).toHaveLength(1);
      });

      it('өөр гэрээнд зэрэг идэвхтэй хүсэлт байж болно', async () => {
        const a = await store.create(newRequest());
        const b = await store.create(newRequest());
        expect((await store.findActiveByContract(a.contractId))?.id).toBe(a.id);
        expect((await store.findActiveByContract(b.contractId))?.id).toBe(b.id);
      });

      it('tokenHash давхцвал SigningUniqueViolationError(tokenHash), юу ч бичигдэхгүй', async () => {
        const first = await store.create(newRequest());
        const clash = newRequest({ tokenHash: first.tokenHash });
        await expect(store.create(clash, { events: [requestedEvent(clash)] })).rejects.toMatchObject({ name: 'SigningUniqueViolationError', field: 'tokenHash' });
        expect(await store.getById(clash.id)).toBeNull();
        expect(await outbox()).toEqual([]);
      });

      it('id давхцвал SigningUniqueViolationError(id)', async () => {
        const first = await store.create(newRequest());
        await expect(store.create(newRequest({ id: first.id }))).rejects.toMatchObject({ name: 'SigningUniqueViolationError', field: 'id' });
      });

      it('UUID биш id → SigningConstraintError', async () => {
        await expect(store.create(newRequest({ id: 'not-a-uuid' }))).rejects.toBeInstanceOf(SigningConstraintError);
      });

      it('event-ийн eventId давхцвал (outbox PRIMARY KEY) бүх create буцаагдана', async () => {
        const first = newRequest();
        const event = requestedEvent(first);
        await store.create(first, { events: [event] });

        const second = newRequest();
        const error = await store.create(second, { audit: [audit('CREATED', time.now())], events: [requestedEvent(second, { eventId: event.eventId })] }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(SigningUniqueViolationError);
        expect((error as SigningUniqueViolationError).field).toBe('eventId');
        expect(await store.getById(second.id)).toBeNull();
        expect(await store.listAudit(second.id)).toEqual([]);
        expect(await outbox()).toHaveLength(1);
      });

      it('нэг create-д ижил eventId хоёр удаа орвол бүгд буцаагдана', async () => {
        const input = newRequest();
        const event = requestedEvent(input);
        await expect(store.create(input, { events: [event, event] })).rejects.toBeInstanceOf(SigningUniqueViolationError);
        expect(await store.getById(input.id)).toBeNull();
        expect(await outbox()).toEqual([]);
      });
    });

    describe('унших', () => {
      it('getById: байхгүй, UUID биш id → null', async () => {
        expect(await store.getById(randomUUID())).toBeNull();
        expect(await store.getById('not-a-uuid')).toBeNull();
      });

      it('getByTokenHash', async () => {
        const created = await store.create(newRequest());
        expect((await store.getByTokenHash(created.tokenHash))?.id).toBe(created.id);
        expect(await store.getByTokenHash('0'.repeat(64))).toBeNull();
      });

      it('getByProviderRef: provider-ээр ялгана; (provider, providerRef) unique', async () => {
        const a = await store.create(newRequest());
        const b = await store.create(newRequest());
        await store.transition(a.id, ['PENDING'], { status: 'IN_PROGRESS', provider: 'TRIDUM', providerRef: 'REF-1' });

        // Өөр provider дээр ижил ref зөвшөөрөгдөнө
        await store.transition(b.id, ['PENDING'], { status: 'IN_PROGRESS', provider: 'MONPASS', providerRef: 'REF-1' });
        expect((await store.getByProviderRef('TRIDUM', 'REF-1'))?.id).toBe(a.id);
        expect((await store.getByProviderRef('MONPASS', 'REF-1'))?.id).toBe(b.id);
        expect(await store.getByProviderRef('TRIDUM', 'NOPE')).toBeNull();

        // Ижил provider + ref давхцвал татгалзана
        const c = await store.create(newRequest());
        await expect(store.transition(c.id, ['PENDING'], { status: 'IN_PROGRESS', provider: 'TRIDUM', providerRef: 'REF-1' }))
          .rejects.toMatchObject({ name: 'SigningUniqueViolationError', field: 'providerRef' });
        expect((await store.getById(c.id))?.status).toBe('PENDING');
      });

      it('providerRef null байхад (provider, providerRef) unique хамаарахгүй', async () => {
        await store.create(newRequest());
        await store.create(newRequest());
        await expect(store.create(newRequest())).resolves.toBeDefined();
      });

      it('getByVerificationCode ба unique', async () => {
        const a = await store.create(newRequest());
        const b = await store.create(newRequest());
        const patch = signedPatch({ verificationCode: 'ABCD1234EFGH' });
        await store.transition(a.id, ['PENDING'], patch);
        expect((await store.getByVerificationCode('ABCD1234EFGH'))?.id).toBe(a.id);
        expect(await store.getByVerificationCode('ZZZZ0000ZZZZ')).toBeNull();

        await expect(store.transition(b.id, ['PENDING'], signedPatch({ verificationCode: 'ABCD1234EFGH' })))
          .rejects.toMatchObject({ name: 'SigningUniqueViolationError', field: 'verificationCode' });
        expect((await store.getById(b.id))?.status).toBe('PENDING');
      });

      it('findActiveByContract: идэвхтэй төлвүүдэд олдоно, төгсгөлийн төлөвт null', async () => {
        const created = await store.create(newRequest());
        expect((await store.findActiveByContract(created.contractId))?.id).toBe(created.id);
        await store.transition(created.id, ['PENDING'], { status: 'IN_PROGRESS' });
        expect((await store.findActiveByContract(created.contractId))?.status).toBe('IN_PROGRESS');
        await store.transition(created.id, ['IN_PROGRESS'], { status: 'FINALIZING' });
        expect((await store.findActiveByContract(created.contractId))?.status).toBe('FINALIZING');
        await store.transition(created.id, ['FINALIZING'], { status: 'FAILED', failureReason: 'PROVIDER_ERROR' });
        expect(await store.findActiveByContract(created.contractId)).toBeNull();
        expect(await store.findActiveByContract('unknown-contract')).toBeNull();
      });

      it('listByApplication: зөвхөн тухайн хүсэлтийнх, шинэ нь түрүүлж', async () => {
        const applicationId = `app-${randomUUID()}`;
        const first = await store.create(newRequest({ applicationId }));
        time.advance(1000);
        const second = await store.create(newRequest({ applicationId }));
        time.advance(1000);
        const third = await store.create(newRequest({ applicationId }));
        await store.create(newRequest());

        expect((await store.listByApplication(applicationId)).map((r) => r.id)).toEqual([third.id, second.id, first.id]);
        expect(await store.listByApplication('app-none')).toEqual([]);
      });
    });

    describe('transition (compare-and-set)', () => {
      it('төлөв from-д байвал patch-ийг хэрэглэж, updatedAt шинэчилнэ; createdAt хэвээр', async () => {
        const created = await store.create(newRequest());
        time.advance(5000);
        const updated = await store.transition(created.id, ['PENDING'], {
          status: 'IN_PROGRESS', provider: 'TRIDUM', providerRef: 'REF-9', challengeCode: '4821', deepLink: 'mock-tridum://sign/1',
          sessionExpiresAt: new Date('2026-10-28T10:05:00.000Z'), attempts: 1, consentAt: time.now(),
        });

        expect(updated).toMatchObject({
          id: created.id, status: 'IN_PROGRESS', provider: 'TRIDUM', providerRef: 'REF-9', challengeCode: '4821', attempts: 1,
          createdAt: created.createdAt, updatedAt: time.now(),
        });
        expect(updated?.sessionExpiresAt).toEqual(new Date('2026-10-28T10:05:00.000Z'));
        expect(await store.getById(created.id)).toEqual(updated);
      });

      it('төлөв from-д байхгүй бол null: patch, аудит, event ЮУ Ч бичигдэхгүй', async () => {
        const created = await store.create(newRequest());
        const event = requestedEvent(created);

        const result = await store.transition(created.id, ['IN_PROGRESS', 'FINALIZING'], { status: 'SIGNED', attempts: 9 }, { audit: [audit('SIGNED', time.now())], events: [event] });

        expect(result).toBeNull();
        expect(await store.getById(created.id)).toEqual(created);
        expect(await store.listAudit(created.id)).toEqual([]);
        expect(await outbox()).toEqual([]);
      });

      it('байхгүй id, UUID биш id, хоосон from → null', async () => {
        const created = await store.create(newRequest());
        expect(await store.transition(randomUUID(), ['PENDING'], { attempts: 1 })).toBeNull();
        expect(await store.transition('not-a-uuid', ['PENDING'], { attempts: 1 })).toBeNull();
        expect(await store.transition(created.id, [], { attempts: 1 })).toBeNull();
        expect((await store.getById(created.id))?.attempts).toBe(0);
      });

      it('төлөв хэвээр үлдэх patch (from-д тухайн төлөв)', async () => {
        const created = await store.create(newRequest());
        const updated = await store.transition(created.id, ['PENDING'], { status: 'PENDING', documentViewedAt: time.now() });
        expect(updated).toMatchObject({ status: 'PENDING', documentViewedAt: time.now() });
      });

      it('null нь талбарыг цэвэрлэнэ (IN_PROGRESS → PENDING дахин оролдлого), undefined нь өөрчлөхгүй', async () => {
        const created = await store.create(newRequest());
        await store.transition(created.id, ['PENDING'], {
          status: 'IN_PROGRESS', provider: 'TRIDUM', providerRef: 'REF-2', challengeCode: '1234', deepLink: 'mock-tridum://x', sessionExpiresAt: time.now(), attempts: 1,
        });

        const retried = await store.transition(created.id, ['IN_PROGRESS'], {
          status: 'PENDING', providerRef: null, challengeCode: null, deepLink: null, sessionExpiresAt: null, attempts: undefined, provider: undefined,
        });

        expect(retried).toMatchObject({ status: 'PENDING', providerRef: null, challengeCode: null, deepLink: null, sessionExpiresAt: null, attempts: 1, provider: 'TRIDUM' });
      });

      it('бүтэн record тарааж өгсөн ч id, createdAt хувирахгүй; мэдэгдэхгүй түлхүүр үл хэрэгсэгдэнэ', async () => {
        const created = await store.create(newRequest());
        time.advance(1000);
        const hostile = { ...created, id: randomUUID(), createdAt: new Date('2000-01-01T00:00:00.000Z'), updatedAt: new Date('2000-01-01T00:00:00.000Z'), status: 'IN_PROGRESS' as const, bogus: 'x' };

        const updated = await store.transition(created.id, ['PENDING'], hostile);

        expect(updated).toMatchObject({ id: created.id, createdAt: created.createdAt, updatedAt: time.now(), status: 'IN_PROGRESS' });
        expect(updated).not.toHaveProperty('bogus');
        expect(await store.getById(hostile.id)).toBeNull();
      });

      it('patch + аудит + event нэг дор бичигдэнэ', async () => {
        const created = await store.create(newRequest());
        const event = requestedEvent(created);
        time.advance(1000);

        await store.transition(created.id, ['PENDING'], { status: 'IN_PROGRESS' }, {
          audit: [audit('PROVIDER_SESSION_STARTED', time.now(), { actor: 'BORROWER', userAgent: 'UA/1.0' }), audit('CONSENT_GIVEN', time.now())],
          events: [event],
        });

        const trail = await store.listAudit(created.id);
        expect(trail.map((e) => e.type)).toEqual(['PROVIDER_SESSION_STARTED', 'CONSENT_GIVEN']);
        expect(trail[0]).toMatchObject({ actor: 'BORROWER', userAgent: 'UA/1.0', ip: null, detail: {} });
        expect(await outbox()).toEqual([{ id: event.eventId, type: event.type, payload: event }]);
      });

      it('patch дахь unique зөрчил → алдаа; мөр, аудит, event ХАМТ буцаагдана (атомик)', async () => {
        const taken = await store.create(newRequest());
        await store.transition(taken.id, ['PENDING'], signedPatch({ verificationCode: 'TAKEN0000001' }));
        const target = await store.create(newRequest());
        const event = requestedEvent(target);

        await expect(store.transition(target.id, ['PENDING'], signedPatch({ verificationCode: 'TAKEN0000001' }), { audit: [audit('SIGNED', time.now())], events: [event] }))
          .rejects.toBeInstanceOf(SigningUniqueViolationError);

        expect(await store.getById(target.id)).toEqual(target);
        expect(await store.listAudit(target.id)).toEqual([]);
        expect(await outbox()).toEqual([]);
      });

      it('давхардсан eventId → алдаа; patch ба аудит буцаагдана', async () => {
        const a = await store.create(newRequest());
        const b = await store.create(newRequest());
        const event = requestedEvent(a);
        await store.transition(a.id, ['PENDING'], { status: 'IN_PROGRESS' }, { events: [event] });

        await expect(store.transition(b.id, ['PENDING'], { status: 'IN_PROGRESS' }, { audit: [audit('OPENED', time.now())], events: [requestedEvent(b, { eventId: event.eventId })] }))
          .rejects.toMatchObject({ name: 'SigningUniqueViolationError', field: 'eventId' });

        expect((await store.getById(b.id))?.status).toBe('PENDING');
        expect(await store.listAudit(b.id)).toEqual([]);
        expect(await outbox()).toHaveLength(1);
      });

      it('төгсгөлийн төлвөөс идэвхтэй болгоход тухайн гэрээнд өөр идэвхтэй байвал ActiveSigningExistsError', async () => {
        const old = await store.create(newRequest());
        await store.transition(old.id, ['PENDING'], { status: 'CANCELLED', failureReason: 'CANCELLED' });
        await store.create(newRequest({ contractId: old.contractId, applicationId: old.applicationId }));

        const error = await store.transition(old.id, ['CANCELLED'], { status: 'PENDING', failureReason: null }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ActiveSigningExistsError);
        expect((error as ActiveSigningExistsError).contractId).toBe(old.contractId);
        expect((await store.getById(old.id))?.status).toBe('CANCELLED');
      });

      it('SIGNED: гэрчилгээ (огноотой), файл, баталгаажуулах код бүрэн хадгалагдаж буцаж уншигдана', async () => {
        const created = await store.create(newRequest());
        const patch = signedPatch({ certificate: certificate({ notBefore: new Date('2026-02-03T04:05:06.789Z') }) });
        const signed = await store.transition(created.id, ['PENDING'], patch);

        expect(signed).toMatchObject({ status: 'SIGNED', verificationCode: patch.verificationCode, signedAt: patch.signedAt, providerMock: true });
        expect(signed?.certificate).toEqual(patch.certificate);
        expect((await store.getById(created.id))?.certificate?.notBefore).toEqual(new Date('2026-02-03T04:05:06.789Z'));
        expect((await store.getByVerificationCode(patch.verificationCode as string))?.id).toBe(created.id);
      });

      it('гэрчилгээг null болгож цэвэрлэнэ', async () => {
        const created = await store.create(newRequest());
        await store.transition(created.id, ['PENDING'], { status: 'IN_PROGRESS', certificate: certificate() });
        const cleared = await store.transition(created.id, ['IN_PROGRESS'], { status: 'PENDING', certificate: null });
        expect(cleared?.certificate).toBeNull();
        expect((await store.getById(created.id))?.certificate).toBeNull();
      });

      it('SIGNED нь файл/код/огноогүй бол SigningConstraintError, мөр өөрчлөгдөхгүй', async () => {
        const created = await store.create(newRequest());
        const error = await store.transition(created.id, ['PENDING'], { status: 'SIGNED', signedAt: time.now() }, { audit: [audit('SIGNED', time.now())] }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SigningConstraintError);
        expect((error as SigningConstraintError).constraint).toBe('signing_request_signed_complete_check');
        expect(await store.getById(created.id)).toEqual(created);
        expect(await store.listAudit(created.id)).toEqual([]);
      });

      it.each([
        ['status', 'signing_request_status_check', { status: 'BOGUS' }],
        ['provider', 'signing_request_provider_check', { provider: 'DIGICERT' }],
        ['failureReason', 'signing_request_failure_reason_check', { failureReason: 'WHATEVER' }],
        ['attempts', 'signing_request_attempts_check', { attempts: -1 }],
      ])('буруу %s → SigningConstraintError(%s)', async (_field, constraint, patch) => {
        const created = await store.create(newRequest());
        const error = await store.transition(created.id, ['PENDING'], patch as never).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SigningConstraintError);
        expect((error as SigningConstraintError).constraint).toBe(constraint);
        expect(await store.getById(created.id)).toEqual(created);
      });

      it('зэрэгцээ хоёр transition: яг нэг нь ялж, зөвхөн ялагчийн patch/аудит/event хадгалагдана', async () => {
        const created = await store.create(newRequest());
        const eventA = requestedEvent(created);
        const eventB = requestedEvent(created);

        const results = await Promise.all([
          store.transition(created.id, ['PENDING'], { status: 'IN_PROGRESS', provider: 'TRIDUM', providerRef: 'RACE-A' }, { audit: [audit('PROVIDER_SESSION_STARTED', time.now())], events: [eventA] }),
          store.transition(created.id, ['PENDING'], { status: 'CANCELLED', failureReason: 'CANCELLED' }, { audit: [audit('CANCELLED', time.now())], events: [eventB] }),
        ]);

        const winners = results.filter((r): r is SigningRequestRecord => r !== null);
        expect(winners).toHaveLength(1);
        const winnerIsA = results[0] !== null;
        expect(await store.getById(created.id)).toEqual(winners[0]);
        expect((await store.listAudit(created.id)).map((e) => e.type)).toEqual([winnerIsA ? 'PROVIDER_SESSION_STARTED' : 'CANCELLED']);
        expect(await outbox()).toEqual([{ id: (winnerIsA ? eventA : eventB).eventId, type: 'ContractSigningRequested', payload: winnerIsA ? eventA : eventB }]);
      });

      it('8 зэрэгцээ transition: яг нэг ялагч', async () => {
        const created = await store.create(newRequest());
        const results = await Promise.all(
          Array.from({ length: 8 }, (_unused, index) => store.transition(created.id, ['PENDING'], { status: 'IN_PROGRESS', attempts: index + 1 }, { audit: [audit('PROVIDER_SESSION_STARTED', time.now(), { detail: { n: index } })] })),
        );
        const winners = results.filter((r): r is SigningRequestRecord => r !== null);
        expect(winners).toHaveLength(1);
        expect((await store.getById(created.id))?.attempts).toBe(winners[0].attempts);
        expect(await store.listAudit(created.id)).toHaveLength(1);
      });
    });

    describe('defensive copy', () => {
      it('буцаасан record-ыг (Date, certificate) өөрчилсөн ч хадгалсан төлөв хувирахгүй', async () => {
        const created = await store.create(newRequest());
        await store.transition(created.id, ['PENDING'], { status: 'IN_PROGRESS', certificate: certificate(), sessionExpiresAt: new Date('2026-10-28T10:05:00.000Z') });

        const read = await store.getById(created.id);
        if (!read?.certificate || !read.sessionExpiresAt) throw new Error('fixture');
        read.status = 'SIGNED';
        read.certificate.issuer = 'TAMPERED';
        read.sessionExpiresAt.setFullYear(1999);
        read.createdAt.setFullYear(1999);

        const reread = await store.getById(created.id);
        expect(reread).toMatchObject({ status: 'IN_PROGRESS', createdAt: created.createdAt });
        expect(reread?.certificate?.issuer).toBe('LOS MOCK CA (ТЕСТ)');
        expect(reread?.sessionExpiresAt).toEqual(new Date('2026-10-28T10:05:00.000Z'));
      });

      it('create/transition-д өгсөн объектыг дараа нь өөрчилсөн ч хадгалсан төлөв хувирахгүй', async () => {
        const input = newRequest();
        const cert = certificate();
        const patch = { status: 'IN_PROGRESS' as const, certificate: cert, sessionExpiresAt: new Date('2026-10-28T10:05:00.000Z') };
        const entry = audit('OPENED', time.now(), { detail: { page: 1 } });

        await store.create(input, { audit: [entry] });
        await store.transition(input.id, ['PENDING'], patch);
        input.signerName = 'TAMPERED';
        input.linkExpiresAt.setFullYear(1999);
        cert.issuer = 'TAMPERED';
        patch.sessionExpiresAt.setFullYear(1999);
        entry.detail = { page: 2 };

        const stored = await store.getById(input.id);
        expect(stored?.signerName).toBe('Бат-Эрдэнэ Болд');
        expect(stored?.linkExpiresAt).toEqual(new Date('2026-10-31T10:00:00.000Z'));
        expect(stored?.certificate?.issuer).toBe('LOS MOCK CA (ТЕСТ)');
        expect(stored?.sessionExpiresAt).toEqual(new Date('2026-10-28T10:05:00.000Z'));
        expect((await store.listAudit(input.id))[0].detail).toEqual({ page: 1 });
      });

      it('listAudit-ийн буцаасан утгыг өөрчилсөн ч хадгалсан аудит хувирахгүй', async () => {
        const created = await store.create(newRequest());
        await store.appendAudit(created.id, audit('OPENED', time.now(), { detail: { page: 1 } }));
        const first = await store.listAudit(created.id);
        first[0].detail = { page: 99 };
        first[0].at.setFullYear(1999);
        first.pop();

        const second = await store.listAudit(created.id);
        expect(second).toHaveLength(1);
        expect(second[0].detail).toEqual({ page: 1 });
        expect(second[0].at).toEqual(time.now());
      });
    });

    describe('аудит', () => {
      it('appendAudit нэмж, listAudit at-аар (ижил цагт оруулсан дарааллаар) буцаана; ip/userAgent/detail normalize', async () => {
        const created = await store.create(newRequest());
        const t0 = time.now();
        await store.appendAudit(created.id, audit('DOCUMENT_VIEWED', new Date(t0.getTime() + 2000), { actor: 'BORROWER', ip: '203.0.113.7', userAgent: 'Mozilla/5.0', detail: { pages: 5, nested: { ok: true } } }));
        await store.appendAudit(created.id, audit('OPENED', t0));
        await store.appendAudit(created.id, audit('LINK_ROTATED', t0));

        const trail = await store.listAudit(created.id);
        expect(trail.map((e) => e.type)).toEqual(['OPENED', 'LINK_ROTATED', 'DOCUMENT_VIEWED']);
        expect(trail[2]).toEqual({ type: 'DOCUMENT_VIEWED', actor: 'BORROWER', at: new Date(t0.getTime() + 2000), ip: '203.0.113.7', userAgent: 'Mozilla/5.0', detail: { pages: 5, nested: { ok: true } } });
        expect(trail[0]).toEqual({ type: 'OPENED', actor: 'SYSTEM', at: t0, ip: null, userAgent: null, detail: {} });
      });

      it('detail нь JSON хэлбэрээр хадгалагдана (Date → ISO string, undefined хасагдана)', async () => {
        const created = await store.create(newRequest());
        await store.appendAudit(created.id, audit('FAILED', time.now(), { detail: { when: new Date('2026-10-28T12:00:00.000Z'), skipped: undefined, code: 'X' } }));
        expect((await store.listAudit(created.id))[0].detail).toEqual({ when: '2026-10-28T12:00:00.000Z', code: 'X' });
      });

      it('байхгүй хүсэлтэд appendAudit → SigningRequestNotFoundError; listAudit → []', async () => {
        await expect(store.appendAudit(randomUUID(), audit('OPENED', time.now()))).rejects.toBeInstanceOf(SigningRequestNotFoundError);
        await expect(store.appendAudit('not-a-uuid', audit('OPENED', time.now()))).rejects.toBeInstanceOf(SigningRequestNotFoundError);
        expect(await store.listAudit(randomUUID())).toEqual([]);
        expect(await store.listAudit('not-a-uuid')).toEqual([]);
      });
    });

    describe('listExpirable', () => {
      it('хугацаа дууссан PENDING|IN_PROGRESS болон гацсан FINALIZING-ийг л буцаана; link_expires_at өсөхөөр', async () => {
        const base = time.now().getTime();
        const at = (offsetMs: number): Date => new Date(base + offsetMs);

        const expiredPending = await store.create(newRequest({ linkExpiresAt: at(-3000) }));
        const expiredInProgress = await store.create(newRequest({ linkExpiresAt: at(-5000) }));
        await store.transition(expiredInProgress.id, ['PENDING'], { status: 'IN_PROGRESS' });
        await store.create(newRequest({ linkExpiresAt: at(60_000) })); // хугацаа дуураагүй
        await store.create(newRequest({ linkExpiresAt: at(0) })); // яг одоо: "<" тул орохгүй
        const terminal = await store.create(newRequest({ linkExpiresAt: at(-9000) }));
        await store.transition(terminal.id, ['PENDING'], { status: 'DECLINED', failureReason: 'DECLINED' });

        const stale = await store.create(newRequest({ linkExpiresAt: at(86_400_000) }));
        await store.transition(stale.id, ['PENDING'], { status: 'FINALIZING' }); // updatedAt = base
        time.advance(120_000);
        const fresh = await store.create(newRequest({ linkExpiresAt: at(86_400_000) }));
        await store.transition(fresh.id, ['PENDING'], { status: 'FINALIZING' }); // updatedAt = base + 120s

        // now = base: хугацаа дууссан хоёр (-5000, -3000); finalizingStaleBefore = base + 60s: updatedAt = base-тай stale орно, fresh орохгүй
        const result = await store.listExpirable(at(0), at(60_000), 50);

        expect(result.map((r) => r.id)).toEqual([expiredInProgress.id, expiredPending.id, stale.id]);
      });

      it('линк хүчинтэй ч provider session дууссан IN_PROGRESS-ийг буцаана (poll/webhook-гүй баталгаажсан байж болно); session үргэлжилж буй нь орохгүй', async () => {
        const base = time.now().getTime();
        const at = (offsetMs: number): Date => new Date(base + offsetMs);
        const sessionOver = await store.create(newRequest({ linkExpiresAt: at(86_400_000) }));
        await store.transition(sessionOver.id, ['PENDING'], { status: 'IN_PROGRESS', sessionExpiresAt: at(-1000) });
        const sessionLive = await store.create(newRequest({ linkExpiresAt: at(86_400_000) }));
        await store.transition(sessionLive.id, ['PENDING'], { status: 'IN_PROGRESS', sessionExpiresAt: at(60_000) });

        const result = await store.listExpirable(at(0), at(-86_400_000), 50);

        expect(result.map((r) => r.id)).toEqual([sessionOver.id]);
      });

      it('limit-ийг хүндэтгэнэ; limit ≤ 0 бол хоосон', async () => {
        const base = time.now().getTime();
        for (let i = 0; i < 3; i += 1) await store.create(newRequest({ linkExpiresAt: new Date(base - 1000 * (i + 1)) }));
        const farPast = new Date(base - 10_000_000);
        expect(await store.listExpirable(time.now(), farPast, 2)).toHaveLength(2);
        expect(await store.listExpirable(time.now(), farPast, 0)).toEqual([]);
      });
    });
  });
}
