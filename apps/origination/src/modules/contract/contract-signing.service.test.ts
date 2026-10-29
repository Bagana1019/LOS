import { BadGatewayException, ConflictException, ForbiddenException, GatewayTimeoutException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ApplicationStatus, type UserRole } from '@los/contracts';
import { describe, expect, it, vi } from 'vitest';
import { APPLICATION_ID, application, context, createHarness, GENERATED_FILE_ID, NOW, silenceLogs } from './contract-signing.fixtures';
import type { IssuedSigningRequest } from './esign.gateway';

silenceLogs();

const AUTHORIZED = context('OFFICER');

/** start() эхэлсэн, PENDING хүсэлттэй орчин */
async function started(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  const view = await h.service.start(APPLICATION_ID, {}, AUTHORIZED);
  return { ...h, view };
}

// Эрхийг (`application:write|read`) controller-ийн @Permissions шалгана; service нь өгөгдлийн хүрээ (NFR-3: assertInScope) ба байгууллагыг шалгана.
describe('ContractSigningService: өгөгдлийн хүрээ (NFR-3)', () => {
  type Case = { name: string; roles: UserRole[]; userId?: string; branchId?: string | null; app?: Parameters<typeof application>[0]; allowed: boolean };
  const cases: Case[] = [
    { name: 'ADMIN дурын салбар/ЗЭЗ', roles: ['ADMIN'], userId: 'admin-1', branchId: 'other-branch', allowed: true },
    { name: 'BRANCH_MANAGER өөрийн салбар', roles: ['BRANCH_MANAGER'], userId: 'mgr-1', branchId: 'branch-1', allowed: true },
    { name: 'BRANCH_MANAGER өөр салбар', roles: ['BRANCH_MANAGER'], userId: 'mgr-1', branchId: 'branch-2', allowed: false },
    { name: 'BRANCH_MANAGER салбарын толгойгүй', roles: ['BRANCH_MANAGER'], userId: 'mgr-1', branchId: null, allowed: false },
    { name: 'OFFICER өөрийн хүсэлт', roles: ['OFFICER'], userId: 'officer-1', allowed: true },
    { name: 'OFFICER өөр ЗЭЗ-ийн хүсэлт', roles: ['OFFICER'], userId: 'officer-2', allowed: false },
    { name: 'OFFICER, ЗЭЗ нь "Систем" (null) хүсэлт', roles: ['OFFICER'], userId: 'officer-1', app: { officerId: null }, allowed: false },
    { name: 'OFFICER өөрийн салбарын боловч өөр ЗЭЗ', roles: ['OFFICER'], userId: 'officer-2', branchId: 'branch-1', allowed: false },
    { name: 'APPROVER (хүрээ ALL; бичих эрхгүйг controller хаана)', roles: ['APPROVER'], userId: 'approver-1', branchId: 'branch-1', allowed: true },
    { name: 'role-гүй', roles: [], userId: 'officer-1', allowed: false },
    { name: 'OFFICER + BRANCH_MANAGER (хамгийн өргөн хүрээ) өөр ЗЭЗ, өөрийн салбар', roles: ['OFFICER', 'BRANCH_MANAGER'], userId: 'officer-2', branchId: 'branch-1', allowed: true },
    { name: 'OFFICER + BRANCH_MANAGER өөр ЗЭЗ, өөр салбар', roles: ['OFFICER', 'BRANCH_MANAGER'], userId: 'officer-2', branchId: 'branch-2', allowed: false },
  ];

  type Ctx = ReturnType<typeof context>;
  const operations: Record<string, (h: ReturnType<typeof createHarness>, ctx: Ctx) => Promise<unknown>> = {
    start: (h, ctx) => h.service.start(APPLICATION_ID, {}, ctx),
    resend: (h, ctx) => h.service.resend(APPLICATION_ID, ctx),
    cancel: (h, ctx) => h.service.cancel(APPLICATION_ID, ctx),
    getStatus: (h, ctx) => h.service.getStatus(APPLICATION_ID, ctx),
  };

  describe.each(Object.keys(operations))('%s', (op) => {
    it('өөр байгууллагын хүсэлт 404 (байгаа эсэхийг задруулахгүй), dms-д хүрэхгүй', async () => {
      const h = createHarness();
      if (op !== 'start') await h.service.start(APPLICATION_ID, {}, context('ADMIN'));
      const callsBefore = h.gateway.calls.length;
      await expect(operations[op]!(h, context('ADMIN', { orgId: 'org-2' }))).rejects.toBeInstanceOf(NotFoundException);
      expect(h.gateway.calls.length).toBe(callsBefore);
    });

    it.each(cases)('$name → $allowed', async (c) => {
      const h = createHarness();
      // start-аас бусад үйлдэлд идэвхтэй хүсэлт урьдчилан үүсгэнэ (ADMIN-аар), дараа нь хүсэлтийн ЗЭЗ/салбарыг тохиолдлоор солино
      if (op !== 'start') await h.service.start(APPLICATION_ID, {}, context('ADMIN'));
      h.lookup.set(application(c.app));
      const ctx = context(c.roles, { userId: c.userId ?? 'officer-1', branchId: c.branchId === undefined ? 'branch-1' : c.branchId });
      const callsBefore = h.gateway.calls.length;

      if (c.allowed) {
        await expect(operations[op]!(h, ctx)).resolves.toMatchObject({ applicationId: APPLICATION_ID });
      } else {
        await expect(operations[op]!(h, ctx)).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.gateway.calls.length).toBe(callsBefore); // dms-д хүрээгүй
      }
    });
  });

  it('хүсэлт олдохгүй бол 404', async () => {
    const h = createHarness({ application: null });
    await expect(h.service.start('missing-app', {}, AUTHORIZED)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('application lookup холбогдоогүй (503) алдааг дамжуулна', async () => {
    const h = createHarness();
    vi.spyOn(h.lookup, 'getForSigning').mockRejectedValue(new ServiceUnavailableException('not wired'));
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('ContractSigningService.start: урьдчилсан нөхцөл', () => {
  const notSignable = ApplicationStatus.filter((s) => s !== 'APPROVED' && s !== 'DISBURSING');

  it.each(notSignable)('хүсэлтийн төлөв %s бол 409', async (status) => {
    const h = createHarness({ application: { status } });
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
    expect(h.gateway.calls).toHaveLength(0);
  });

  it.each(['APPROVED', 'DISBURSING'] as const)('хүсэлтийн төлөв %s бол зөвшөөрнө', async (status) => {
    const h = createHarness({ application: { status } });
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('гэрээний мөр байхгүй бол 409 "Гэрээ үүсээгүй байна"', async () => {
    const h = createHarness({ contract: false });
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toThrow('Гэрээ үүсээгүй байна');
    expect(h.gateway.calls).toHaveLength(0);
  });

  it('generatedFileId байхгүй бол 409 "Гэрээ үүсээгүй байна"', async () => {
    const h = createHarness({ contract: false });
    h.contracts.seed({ applicationId: APPLICATION_ID, contractNo: 'B10026102801', generatedFileId: null });
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toThrow('Гэрээ үүсээгүй байна');
  });

  it('аль хэдийн SIGNED бол 409', async () => {
    const h = createHarness({ contract: false });
    h.contracts.seed({ applicationId: APPLICATION_ID, contractNo: 'B10026102801', generatedFileId: GENERATED_FILE_ID, signingStatus: 'SIGNED', signedFileId: 'file-signed-1', signChannel: 'ESIGN' });
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
    expect(h.gateway.calls).toHaveLength(0);
  });

  it('цаасаар гарын үсэг зурагдсан (signed_file_id байгаа) бол 409', async () => {
    const h = createHarness({ contract: false });
    h.contracts.seed({ applicationId: APPLICATION_ID, contractNo: 'B10026102801', generatedFileId: GENERATED_FILE_ID, signedFileId: 'file-scan-1' });
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    ['үндсэн зээлдэгч байхгүй', { primaryBorrower: null }],
    ['утас хоосон', { primaryBorrower: { customerId: 'c', fullName: 'Бат Болд', registerNo: 'УА12345678', phone: '  ' } }],
    ['утасны формат буруу', { primaryBorrower: { customerId: 'c', fullName: 'Бат Болд', registerNo: 'УА12345678', phone: 'abc-123' } }],
    ['регистр хэт богино', { primaryBorrower: { customerId: 'c', fullName: 'Бат Болд', registerNo: 'УА1', phone: '99112233' } }],
  ])('%s бол 409', async (_name, override) => {
    const h = createHarness({ application: override });
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
    expect(h.gateway.calls).toHaveLength(0);
  });

  it('гэрээний дугаар/байгууллага хүсэлттэй таарахгүй бол 409', async () => {
    for (const override of [{ contractNo: 'OTHER' }, { contractNo: null }]) {
      const h = createHarness({ application: override });
      await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
      expect(h.gateway.calls).toHaveLength(0);
    }
    // contract мөр өөр байгууллагынх (өгөгдлийн алдаа) → dms-д хүрэхгүй
    const h = createHarness();
    h.contracts.seed({ applicationId: APPLICATION_ID, orgId: 'org-2', contractNo: 'B10026102801', generatedFileId: GENERATED_FILE_ID });
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
    expect(h.gateway.calls).toHaveLength(0);
  });

  it('утасны дугаарыг нормчилж dms-д өгнө', async () => {
    const h = createHarness({ application: { primaryBorrower: { customerId: 'c', fullName: ' Бат-Эрдэнэ Болд ', registerNo: 'УА12345678', phone: '+976 9911-2233' } } });
    await h.service.start(APPLICATION_ID, {}, AUTHORIZED);
    const sent = h.gateway.calls[0]!.input;
    expect(typeof sent === 'string' ? null : sent.signer).toEqual({ customerId: 'c', fullName: 'Бат-Эрдэнэ Болд', registerNo: 'УА12345678', phone: '+97699112233' });
    expect(h.notifier.sent[0]!.phone).toBe('+97699112233');
  });
});

describe('ContractSigningService.start: амжилттай урсгал', () => {
  it('dms-д бүрэн хүсэлт илгээж, contract мөрийг тэмдэглэж, SMS линк явуулна', async () => {
    const h = createHarness();
    const view = await h.service.start(APPLICATION_ID, { preferredProvider: 'MONPASS', ttlHours: 48 }, context('OFFICER', { correlationId: 'corr-42' }));

    const contract = (await h.contracts.getByApplicationId(APPLICATION_ID))!;
    expect(h.gateway.calls).toHaveLength(1);
    expect(h.gateway.calls[0]).toEqual({
      op: 'createRequest',
      ctx: context('OFFICER', { correlationId: 'corr-42' }),
      input: {
        applicationId: APPLICATION_ID, contractId: contract.id, contractNo: 'B10026102801', sourceFileId: GENERATED_FILE_ID,
        signer: { customerId: 'cust-1', fullName: 'Бат-Эрдэнэ Болд', registerNo: 'УА12345678', phone: '99112233' },
        preferredProvider: 'MONPASS', ttlHours: 48,
      },
    });
    expect(contract).toMatchObject({ signChannel: 'ESIGN', signingRequestId: view.id, signingStatus: 'PENDING', signingFailureReason: null, signingSentAt: NOW, signedFileId: null });
    expect(h.notifier.sent).toEqual([{ applicationId: APPLICATION_ID, phone: '99112233', signingUrl: expect.stringMatching(/^https:\/\/sign\.example\.test\/sign\//), expiresAt: new Date(view.linkExpiresAt) }]);
  });

  it('signingUrl-ийг ажилтны хариунаас хасна (зөвхөн SMS-д)', async () => {
    const { view, notifier } = await started();
    expect(view).not.toHaveProperty('signingUrl');
    expect(JSON.stringify(view)).not.toContain(notifier.sent[0]!.signingUrl);
    expect(view).toMatchObject({ applicationId: APPLICATION_ID, status: 'PENDING', signerPhoneMasked: expect.stringContaining('****2233') });
  });

  it('өмнөх хүсэлт дууссан (EXPIRED) бол шинэ хүсэлт үүсгэж, failure reason-ийг цэвэрлэнэ', async () => {
    const h = await started();
    h.gateway.setStatus(h.view.id, { status: 'EXPIRED', failureReason: 'EXPIRED' });
    await h.contracts.updateSigning(APPLICATION_ID, { signingStatus: 'EXPIRED', signingFailureReason: 'EXPIRED' });

    const second = await h.service.start(APPLICATION_ID, {}, AUTHORIZED);
    expect(second.id).not.toBe(h.view.id);
    expect(await h.contracts.getByApplicationId(APPLICATION_ID)).toMatchObject({ signingRequestId: second.id, signingStatus: 'PENDING', signingFailureReason: null });
  });

  it('идэвхтэй хүсэлт байхад дахин start → 409 (dms хэрэгжүүлнэ), эхний хүсэлт хэвээр, SMS дахин явахгүй', async () => {
    const h = await started();
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
    expect(await h.contracts.getByApplicationId(APPLICATION_ID)).toMatchObject({ signingRequestId: h.view.id, signingStatus: 'PENDING' });
    expect(h.notifier.sent).toHaveLength(1);
  });

  it('dms-ийн алдаа (503/504) дамжиж, contract мөр өөрчлөгдөхгүй', async () => {
    for (const error of [new ServiceUnavailableException('down'), new GatewayTimeoutException('slow')]) {
      const h = createHarness();
      h.gateway.failNext('createRequest', error);
      await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBe(error);
      expect(await h.contracts.getByApplicationId(APPLICATION_ID)).toMatchObject({ signChannel: 'PAPER', signingRequestId: null, signingStatus: null });
      expect(h.notifier.sent).toHaveLength(0);
    }
  });

  it('dms өөр хүсэлтийн өгөгдөл буцаавал 502 — тэмдэглэхгүй, SMS явуулахгүй', async () => {
    const h = createHarness();
    const real = h.gateway.createRequest.bind(h.gateway);
    vi.spyOn(h.gateway, 'createRequest').mockImplementation(async (...args) => ({ ...(await real(...args)), applicationId: 'someone-elses-app' }));
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBeInstanceOf(BadGatewayException);
    expect((await h.contracts.getByApplicationId(APPLICATION_ID))!.signingRequestId).toBeNull();
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('contract мөрд тэмдэглэх нь унавал dms-ийн хүсэлтийг цуцлаад алдааг дамжуулна (өнчин хүсэлт үлдэхгүй)', async () => {
    const h = createHarness();
    const boom = new Error('db down');
    vi.spyOn(h.contracts, 'updateSigning').mockRejectedValueOnce(boom);
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBe(boom);
    expect(h.gateway.calls.map((c) => c.op)).toEqual(['createRequest', 'cancel']);
    expect(h.notifier.sent).toHaveLength(0);
    // цуцлагдсан тул дахин оролдож болно
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('тэмдэглэх үед гэрээ зэрэгцээгээр SIGNED болсон (false) бол dms-ийн хүсэлтийг цуцлаад 409', async () => {
    const h = createHarness();
    vi.spyOn(h.contracts, 'updateSigning').mockResolvedValueOnce(false);
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
    expect(h.gateway.calls.map((c) => c.op)).toEqual(['createRequest', 'cancel']);
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('цуцлах нь өөрөө унасан ч анхны алдаа алдагдахгүй', async () => {
    const h = createHarness();
    const boom = new Error('db down');
    vi.spyOn(h.contracts, 'updateSigning').mockRejectedValueOnce(boom);
    h.gateway.failNext('cancel', new ServiceUnavailableException('dms down'));
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBe(boom);
  });

  it('SMS илгээж чадаагүй бол 503; хүсэлт идэвхтэй үлдэж signing_sent_at хоосон; resend-ээр засна', async () => {
    const h = createHarness();
    h.notifier.failNext(new Error('smpp error for +97699112233 https://sign.example.test/sign/secret'));
    const err = await h.service.start(APPLICATION_ID, {}, AUTHORIZED).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((err as ServiceUnavailableException).getResponse())).not.toMatch(/secret|99112233|sign\.example/);
    const contract = (await h.contracts.getByApplicationId(APPLICATION_ID))!;
    expect(contract).toMatchObject({ signingStatus: 'PENDING', signingSentAt: null });

    await expect(h.service.resend(APPLICATION_ID, AUTHORIZED)).resolves.toMatchObject({ id: contract.signingRequestId });
    expect(h.notifier.sent).toHaveLength(1);
    expect((await h.contracts.getByApplicationId(APPLICATION_ID))!.signingSentAt).toEqual(NOW);
  });

  it('notifier-ийн HttpException (жишээ нь "холбогдоогүй") өөрчлөгдөхгүй дамжина', async () => {
    const h = createHarness();
    const notWired = new ServiceUnavailableException('TODO(M11): SMS adapter not wired');
    h.notifier.failNext(notWired);
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).rejects.toBe(notWired);
  });
});

describe('ContractSigningService.resend', () => {
  it('линкийг шинэчилж дахин SMS явуулна, signing_sent_at шинэчлэгдэнэ', async () => {
    const h = await started();
    const firstUrl = h.notifier.sent[0]!.signingUrl;
    await h.contracts.updateSigning(APPLICATION_ID, { signingSentAt: new Date('2026-10-28T08:00:00.000Z') });

    const view = await h.service.resend(APPLICATION_ID, context('OFFICER', { correlationId: 'corr-7' }));

    expect(view).not.toHaveProperty('signingUrl');
    expect(h.gateway.calls.at(-1)).toMatchObject({ op: 'resend', input: h.view.id, ctx: { userId: 'officer-1', correlationId: 'corr-7' } });
    expect(h.notifier.sent).toHaveLength(2);
    expect(h.notifier.sent[1]!.signingUrl).not.toBe(firstUrl);
    expect(await h.contracts.getByApplicationId(APPLICATION_ID)).toMatchObject({ signingRequestId: h.view.id, signingStatus: 'PENDING', signingSentAt: NOW });
  });

  it('зээлдэгчийн одоогийн утас руу илгээнэ', async () => {
    const h = await started();
    h.lookup.set(application({ primaryBorrower: { customerId: 'cust-1', fullName: 'Бат-Эрдэнэ Болд', registerNo: 'УА12345678', phone: '88001122' } }));
    await h.service.resend(APPLICATION_ID, AUTHORIZED);
    expect(h.notifier.sent[1]!.phone).toBe('88001122');
  });

  it('хүсэлт огт эхлээгүй бол 409', async () => {
    const h = createHarness();
    await expect(h.service.resend(APPLICATION_ID, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
    expect(h.gateway.calls).toHaveLength(0);
  });

  it.each(['DECLINED', 'EXPIRED', 'FAILED', 'CANCELLED', 'SIGNED'] as const)('хүсэлт %s төлөвт бол dms-д хүрэлгүй 409', async (status) => {
    const h = await started();
    await h.contracts.updateSigning(APPLICATION_ID, { signingStatus: status });
    const before = h.gateway.calls.length;
    await expect(h.service.resend(APPLICATION_ID, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
    expect(h.gateway.calls).toHaveLength(before);
  });

  it('dms дээр хүсэлт аль хэдийн дууссан (орон нутгийн төлөв хоцорсон) бол dms-ийн 409-ийг дамжуулна', async () => {
    const h = await started();
    h.gateway.setStatus(h.view.id, { status: 'EXPIRED' });
    await expect(h.service.resend(APPLICATION_ID, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
    expect(h.notifier.sent).toHaveLength(1);
  });

  it('хүсэлт батлагдсан төлөвөөс гарсан бол 409', async () => {
    const h = await started();
    h.lookup.set(application({ status: 'ACTIVE' }));
    await expect(h.service.resend(APPLICATION_ID, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
  });

  it('SMS унавал 503, signing_sent_at хоосон (хуучин линк үхсэн)', async () => {
    const h = await started();
    h.notifier.failNext(new Error('smpp'));
    await expect(h.service.resend(APPLICATION_ID, AUTHORIZED)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect((await h.contracts.getByApplicationId(APPLICATION_ID))!.signingSentAt).toBeNull();
  });
});

describe('ContractSigningService.cancel', () => {
  it('dms-д цуцалж, contract мөрийг CANCELLED болгоно', async () => {
    const h = await started();
    const view = await h.service.cancel(APPLICATION_ID, AUTHORIZED);

    expect(view).toMatchObject({ id: h.view.id, status: 'CANCELLED', failureReason: 'CANCELLED' });
    expect(view).not.toHaveProperty('signingUrl');
    expect(await h.contracts.getByApplicationId(APPLICATION_ID)).toMatchObject({ signingStatus: 'CANCELLED', signingFailureReason: 'CANCELLED', signingRequestId: h.view.id });
  });

  it('цуцалсны дараа шинэ хүсэлт эхлүүлж болно', async () => {
    const h = await started();
    await h.service.cancel(APPLICATION_ID, AUTHORIZED);
    await expect(h.service.start(APPLICATION_ID, {}, AUTHORIZED)).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('хүсэлт байхгүй / дууссан бол 409', async () => {
    const none = createHarness();
    await expect(none.service.cancel(APPLICATION_ID, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);

    const h = await started();
    await h.service.cancel(APPLICATION_ID, AUTHORIZED);
    await expect(h.service.cancel(APPLICATION_ID, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
  });

  it('dms 409 өгвөл (жишээ нь FINALIZING эсвэл дууссан) contract мөр өөрчлөгдөхгүй', async () => {
    const h = await started();
    h.gateway.setStatus(h.view.id, { status: 'SIGNED' });
    await expect(h.service.cancel(APPLICATION_ID, AUTHORIZED)).rejects.toBeInstanceOf(ConflictException);
    expect(await h.contracts.getByApplicationId(APPLICATION_ID)).toMatchObject({ signingStatus: 'PENDING' });
  });

  it('хүсэлт батлагдсан төлөвөөс гарсан ч идэвхтэй хүсэлтийг цуцлах боломжтой', async () => {
    const h = await started();
    h.lookup.set(application({ status: 'RETURNED' }));
    await expect(h.service.cancel(APPLICATION_ID, AUTHORIZED)).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it('dms SIGNED гэж буцаавал (хуучин хоцролт) contract-ийг SIGNED болгохгүй — зөвхөн event тавина', async () => {
    const h = await started();
    vi.spyOn(h.gateway, 'cancel').mockResolvedValue({ ...(await h.gateway.get(h.view.id, AUTHORIZED)), status: 'SIGNED' });
    await h.service.cancel(APPLICATION_ID, AUTHORIZED);
    expect(await h.contracts.getByApplicationId(APPLICATION_ID)).toMatchObject({ signingStatus: 'PENDING', signedFileId: null });
  });
});

describe('ContractSigningService.getStatus', () => {
  it('dms-ийн төлвийг signingUrl-гүйгээр буцаана', async () => {
    const h = await started();
    h.gateway.setStatus(h.view.id, { status: 'IN_PROGRESS', provider: 'TRIDUM' });
    await expect(h.service.getStatus(APPLICATION_ID, AUTHORIZED)).resolves.toMatchObject({ id: h.view.id, status: 'IN_PROGRESS', provider: 'TRIDUM' });
  });

  it('dms буруугаар signingUrl буцааж болзошгүй — ажилтанд хэзээ ч дамжуулахгүй', async () => {
    const h = await started();
    const leaky: IssuedSigningRequest = { ...(await h.gateway.get(h.view.id, AUTHORIZED)), signingUrl: 'https://sign.example.test/sign/LEAK' };
    vi.spyOn(h.gateway, 'get').mockResolvedValue(leaky);
    const view = await h.service.getStatus(APPLICATION_ID, AUTHORIZED);
    expect(JSON.stringify(view)).not.toContain('LEAK');
  });

  it('хүсэлт эхлээгүй бол 404', async () => {
    const h = createHarness();
    await expect(h.service.getStatus(APPLICATION_ID, AUTHORIZED)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('dms-ийн 404-ийг дамжуулна', async () => {
    const h = createHarness();
    await h.contracts.updateSigning(APPLICATION_ID, { signingRequestId: 'sr-ghost', signingStatus: 'PENDING' });
    await expect(h.service.getStatus(APPLICATION_ID, AUTHORIZED)).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    ['өөр хүсэлтийн id', { id: 'sr-other' }],
    ['өөр application', { applicationId: 'app-2' }],
    ['өөр байгууллага', { orgId: 'org-2' }],
  ])('dms %s буцаавал 502', async (_name, patch) => {
    const h = await started();
    h.gateway.setStatus(h.view.id, patch);
    await expect(h.service.getStatus(APPLICATION_ID, AUTHORIZED)).rejects.toBeInstanceOf(BadGatewayException);
  });
});
