import { describe, expect, it, vi } from 'vitest';
import type { SigningFailureReason, SigningStatus } from '@los/contracts';
import { APPLICATION_ID, context, createHarness, failedEvent, requestedEvent, signedEvent, silenceLogs } from './contract-signing.fixtures';
import { ContractSigningEventHandler } from './contract-signing.event-handler';

silenceLogs();

/** sr-1 хүсэлттэй, PENDING төлөвт contract */
function setup() {
  const h = createHarness();
  const contract = h.contracts.seed({
    applicationId: APPLICATION_ID, orgId: 'org-1', contractNo: 'B10026102801', generatedFileId: 'file-generated-1',
    signChannel: 'ESIGN', signingRequestId: 'sr-1', signingStatus: 'PENDING',
  });
  const handler = new ContractSigningEventHandler(h.contracts);
  const get = () => h.contracts.getByApplicationId(APPLICATION_ID);
  return { ...h, contractId: contract.id, handler, get };
}

describe('ContractSigned', () => {
  it('signed_file_id, signed_at, SIGNED, ESIGN тавина (G4 хаалганы түлхүүр)', async () => {
    const { handler, contractId, get } = setup();
    await handler.handle(signedEvent(contractId));
    expect(await get()).toMatchObject({
      signingStatus: 'SIGNED', signedFileId: 'file-signed-1', signedAt: new Date('2026-10-28T09:04:00.000Z'), signChannel: 'ESIGN', signingFailureReason: null, signingRequestId: 'sr-1',
    });
  });

  it('өмнөх алдааны шалтгааныг цэвэрлэнэ', async () => {
    const { handler, contractId, contracts, get } = setup();
    await contracts.updateSigning(APPLICATION_ID, { signingStatus: 'IN_PROGRESS', signingFailureReason: 'PROVIDER_ERROR' });
    await handler.handle(signedEvent(contractId));
    expect(await get()).toMatchObject({ signingStatus: 'SIGNED', signingFailureReason: null });
  });

  it('дахин хүргэгдэхэд (at-least-once) өөрчлөлтгүй, repository-д бичихгүй', async () => {
    const { handler, contractId, contracts, get } = setup();
    await handler.handle(signedEvent(contractId));
    const first = await get();
    const write = vi.spyOn(contracts, 'updateSigning');

    await handler.handle(signedEvent(contractId));
    await handler.handle(signedEvent(contractId, { signedFileId: 'file-signed-REPLAY' }));

    expect(write).not.toHaveBeenCalled();
    expect(await get()).toEqual(first);
  });

  it('stale: contract-ийн одоогийн хүсэлтээс өөр signingRequestId-тай event-ийг үл тоомсорлоно', async () => {
    const { handler, contractId, contracts, get } = setup();
    await contracts.updateSigning(APPLICATION_ID, { signingRequestId: 'sr-2', signingStatus: 'PENDING' });
    const write = vi.spyOn(contracts, 'updateSigning');
    await handler.handle(signedEvent(contractId, { signingRequestId: 'sr-1' }));
    expect(write).not.toHaveBeenCalled();
    expect(await get()).toMatchObject({ signingRequestId: 'sr-2', signingStatus: 'PENDING', signedFileId: null, signedAt: null });
  });

  it('contract-д signing_request_id байхгүй бол үл тоомсорлоно', async () => {
    const h = createHarness();
    const c = h.contracts.seed({ applicationId: APPLICATION_ID, orgId: 'org-1', generatedFileId: 'f' });
    await new ContractSigningEventHandler(h.contracts).handle(signedEvent(c.id));
    expect(await h.contracts.getByApplicationId(APPLICATION_ID)).toMatchObject({ signingStatus: null, signedFileId: null });
  });

  it.each([
    ['өөр contractId', { contractId: 'other-contract' }],
    ['өөр orgId', { orgId: 'org-2' }],
  ])('%s-тай event-ийг үл тоомсорлоно', async (_name, override) => {
    const { handler, contractId, get } = setup();
    await handler.handle(signedEvent(contractId, override));
    expect(await get()).toMatchObject({ signingStatus: 'PENDING', signedFileId: null });
  });

  it('үл мэдэгдэх хүсэлтийн event алдаа шидэхгүй', async () => {
    const { handler, contractId } = setup();
    await expect(handler.handle(signedEvent(contractId, { applicationId: 'unknown-app' }))).resolves.toBeUndefined();
  });
});

describe('ContractSigningFailed', () => {
  const mapping: [SigningFailureReason, SigningStatus][] = [
    ['DECLINED', 'DECLINED'],
    ['EXPIRED', 'EXPIRED'],
    ['CANCELLED', 'CANCELLED'],
    ['IDENTITY_MISMATCH', 'FAILED'],
    ['INTEGRITY_ERROR', 'FAILED'],
    ['PROVIDER_ERROR', 'FAILED'],
  ];

  it.each(mapping)('шалтгаан %s → төлөв %s, шалтгаан хадгалагдана', async (reason, status) => {
    const { handler, contractId, get } = setup();
    await handler.handle(failedEvent(contractId, { reason }));
    expect(await get()).toMatchObject({ signingStatus: status, signingFailureReason: reason, signedFileId: null, signedAt: null, signingRequestId: 'sr-1' });
  });

  it('дахин хүргэгдэхэд өөрчлөлтгүй, repository-д бичихгүй', async () => {
    const { handler, contractId, contracts, get } = setup();
    await handler.handle(failedEvent(contractId, { reason: 'DECLINED' }));
    const first = await get();
    const write = vi.spyOn(contracts, 'updateSigning');
    await handler.handle(failedEvent(contractId, { reason: 'DECLINED' }));
    expect(write).not.toHaveBeenCalled();
    expect(await get()).toEqual(first);
  });

  it('SIGNED төлвийг хэзээ ч бууруулахгүй (signed_file_id хэвээр)', async () => {
    const { handler, contractId, contracts, get } = setup();
    await handler.handle(signedEvent(contractId));
    const write = vi.spyOn(contracts, 'updateSigning');
    for (const reason of ['DECLINED', 'EXPIRED', 'CANCELLED', 'PROVIDER_ERROR'] as const) {
      await handler.handle(failedEvent(contractId, { reason }));
    }
    expect(write).not.toHaveBeenCalled();
    expect(await get()).toMatchObject({ signingStatus: 'SIGNED', signedFileId: 'file-signed-1', signingFailureReason: null });
  });

  it('stale: шинэ хүсэлт эхэлсний дараа хуучин хүсэлтийн Failed (давтан хүргэлт) шинэ PENDING-ийг дарахгүй', async () => {
    const { handler, contractId, contracts, get } = setup();
    await handler.handle(failedEvent(contractId, { signingRequestId: 'sr-1', reason: 'EXPIRED' }));
    await contracts.updateSigning(APPLICATION_ID, { signingRequestId: 'sr-2', signingStatus: 'PENDING', signingFailureReason: null });
    const write = vi.spyOn(contracts, 'updateSigning');

    await handler.handle(failedEvent(contractId, { signingRequestId: 'sr-1', reason: 'EXPIRED' }));
    await handler.handle(failedEvent(contractId, { signingRequestId: 'sr-1', reason: 'DECLINED' }));

    expect(write).not.toHaveBeenCalled();
    expect(await get()).toMatchObject({ signingRequestId: 'sr-2', signingStatus: 'PENDING', signingFailureReason: null });
  });

  it('stale Signed ч шинэ хүсэлтийг SIGNED болгохгүй', async () => {
    const { handler, contractId, contracts, get } = setup();
    await contracts.updateSigning(APPLICATION_ID, { signingRequestId: 'sr-2', signingStatus: 'PENDING' });
    await handler.handle(signedEvent(contractId, { signingRequestId: 'sr-1' }));
    expect(await get()).toMatchObject({ signingStatus: 'PENDING', signedFileId: null });
  });
});

describe('бусад event', () => {
  it('ContractSigningRequested ба хамааралгүй event-ийг үл тоомсорлоно (уншихгүй, бичихгүй)', async () => {
    const { handler, contractId, contracts, get } = setup();
    const before = await get();
    const read = vi.spyOn(contracts, 'getByApplicationId');
    const write = vi.spyOn(contracts, 'updateSigning');

    await handler.handle(requestedEvent(contractId));
    await handler.handle({ ...signedEvent(contractId), type: 'ApplicationApproved', applicationId: APPLICATION_ID, contractNo: 'B1' } as never);

    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await get()).toEqual(before);
  });
});

describe('найдвартай байдал', () => {
  it('уншсаны дараа зэрэгцээгээр шинэ хүсэлт эхэлсэн (guard алдсан) бол алдаагүй, шинэ хүсэлтийг хөндөхгүй', async () => {
    const { handler, contractId, contracts, get } = setup();
    const realRead = contracts.getByApplicationId.bind(contracts);
    // handler уншсаны дараа, бичихийн өмнө start() шинэ хүсэлт тэмдэглэнэ
    vi.spyOn(contracts, 'getByApplicationId').mockImplementationOnce(async (id) => {
      const snapshot = await realRead(id);
      await contracts.updateSigning(id, { signingRequestId: 'sr-2', signingStatus: 'PENDING' });
      return snapshot;
    });

    await expect(handler.handle(signedEvent(contractId))).resolves.toBeUndefined();
    expect(await get()).toMatchObject({ signingRequestId: 'sr-2', signingStatus: 'PENDING', signedFileId: null });
  });

  it('repository-ийн алдааг шидэж өгнө (bus дахин хүргэнэ)', async () => {
    const { handler, contractId, contracts } = setup();
    vi.spyOn(contracts, 'getByApplicationId').mockRejectedValue(new Error('db down'));
    await expect(handler.handle(signedEvent(contractId))).rejects.toThrow('db down');
  });

  it('start → гарын үсэг → дахин start хориотой: бүтэн урсгал', async () => {
    const h = createHarness();
    const view = await h.service.start(APPLICATION_ID, {}, context('OFFICER'));
    const contract = (await h.contracts.getByApplicationId(APPLICATION_ID))!;

    await new ContractSigningEventHandler(h.contracts).handle(signedEvent(contract.id, { signingRequestId: view.id }));

    expect(await h.contracts.getByApplicationId(APPLICATION_ID)).toMatchObject({ signingStatus: 'SIGNED', signedFileId: 'file-signed-1', signChannel: 'ESIGN' });
    await expect(h.service.start(APPLICATION_ID, {}, context('OFFICER'))).rejects.toThrow('аль хэдийн гарын үсэг зурагдсан');
  });
});
