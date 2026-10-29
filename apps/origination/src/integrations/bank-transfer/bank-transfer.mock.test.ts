import { describe, expect, it } from 'vitest';
import { ProviderRejectedError, ProviderUnavailableError } from '../payment-provider/provider-errors';
import { MOCK_ACCOUNT_HOLDERS, MOCK_COLLECTION_ACCOUNT, MockBankGateway, mockRegisteredName } from './bank-transfer.mock';

const T0 = new Date('2026-10-28T02:00:00Z');

describe('MockBankGateway', () => {
  const gw = () => new MockBankGateway({ now: () => T0 });

  it('registeredName нь дансны сүүлийн цифрээс (deterministic)', () => {
    expect(mockRegisteredName('5012345673')).toBe(MOCK_ACCOUNT_HOLDERS[3]);
    expect(mockRegisteredName('5012345670')).toBe(MOCK_ACCOUNT_HOLDERS[0]);
    expect(mockRegisteredName('50123')).toBe(MOCK_ACCOUNT_HOLDERS[3]);
  });

  it('данс олдохгүй: цифр биш, богино, 0000-оор төгссөн', () => {
    expect(mockRegisteredName('ABC12345')).toBeNull();
    expect(mockRegisteredName('123')).toBeNull();
    expect(mockRegisteredName('5012340000')).toBeNull();
  });

  it('nameCheck: таарсан / таараагүй / данс олдоогүй', async () => {
    const g = gw();
    const ok = await g.nameCheck({ bankCode: 'KHAN', accountNo: '5012345673', holderName: 'ҮҮРЦАЙХ  төмөр' });
    expect(ok).toMatchObject({ matched: true, registeredName: 'Үүрцайх Төмөр', similarity: 1 });
    const bad = await g.nameCheck({ bankCode: 'KHAN', accountNo: '5012345673', holderName: 'Тэмүүлэн Пүрэв' });
    expect(bad.matched).toBe(false);
    expect(bad.registeredName).toBe('Үүрцайх Төмөр');
    expect(bad.similarity).toBeLessThan(0.85);
    expect(await g.nameCheck({ bankCode: 'KHAN', accountNo: '5012340000', holderName: 'Хэн ч' })).toEqual({ matched: false, registeredName: null, similarity: 0 });
  });

  it('pushIncoming: дараалсан MOCKTXN-0001…, анхдагч утгууд', () => {
    const g = gw();
    const a = g.pushIncoming({ amount: 1000, description: 'LOS-X-1' });
    const b = g.pushIncoming({ amount: 2000, description: 'LOS-X-2' });
    expect([a.bankReference, b.bankReference]).toEqual(['MOCKTXN-0001', 'MOCKTXN-0002']);
    expect(a).toMatchObject({ bankCode: MOCK_COLLECTION_ACCOUNT.bankCode, accountNo: MOCK_COLLECTION_ACCOUNT.accountNo, currency: 'MNT', valueDate: T0 });
  });

  it('listIncomingTransfers: данс + since-ээр шүүж, хуулбар буцаана', async () => {
    const g = gw();
    g.pushIncoming({ amount: 1, description: 'a', valueDate: new Date('2026-10-01T00:00:00Z') });
    g.pushIncoming({ amount: 2, description: 'b', valueDate: new Date('2026-10-20T00:00:00Z') });
    g.pushIncoming({ amount: 3, description: 'c', accountNo: '9999999999' });
    const list = await g.listIncomingTransfers({ since: new Date('2026-10-10T00:00:00Z'), accountNo: MOCK_COLLECTION_ACCOUNT.accountNo });
    expect(list.map((t) => t.amount)).toEqual([2]);
    list[0].amount = 999; // дотоод төлөвийг өөрчлөхгүй
    expect((await g.listIncomingTransfers({ since: new Date('2026-10-10T00:00:00Z'), accountNo: MOCK_COLLECTION_ACCOUNT.accountNo }))[0].amount).toBe(2);
  });

  it('transfer: reference-ээр idempotent, дүн эерэг', async () => {
    const g = gw();
    const req = { fromAccountNo: '5000000001', toBankCode: 'GOLOMT', toAccountNo: '1234567', toHolderName: 'Бат', amount: 1000, currency: 'MNT', description: 'олголт', reference: 'DISB-1' };
    const first = await g.transfer(req);
    expect(first).toMatchObject({ status: 'COMPLETED', executedAt: T0 });
    expect(await g.transfer(req)).toEqual(first);
    expect((await g.transfer({ ...req, reference: 'DISB-2' })).bankReference).not.toBe(first.bankReference);
    await expect(g.transfer({ ...req, reference: 'DISB-3', amount: 0 })).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it('failNext: дараагийн дуудлага (эсвэл заасан method) алдаатай, дараа нь хэвийн', async () => {
    const g = gw();
    g.failNext();
    await expect(g.nameCheck({ bankCode: 'KHAN', accountNo: '5012345673', holderName: 'x' })).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(g.nameCheck({ bankCode: 'KHAN', accountNo: '5012345673', holderName: 'x' })).resolves.toBeTruthy();
    g.failNext({ method: 'listIncomingTransfers', times: 2, error: new Error('boom') });
    await expect(g.nameCheck({ bankCode: 'KHAN', accountNo: '5012345673', holderName: 'x' })).resolves.toBeTruthy();
    await expect(g.listIncomingTransfers({ since: T0, accountNo: 'x' })).rejects.toThrow('boom');
    await expect(g.listIncomingTransfers({ since: T0, accountNo: 'x' })).rejects.toThrow('boom');
    await expect(g.listIncomingTransfers({ since: T0, accountNo: 'x' })).resolves.toEqual([]);
  });

  it('mock: үргэлж available', () => {
    const g = gw();
    expect(g.mode).toBe('mock');
    expect(g.isAvailable()).toBe(true);
    expect(g.unavailableReason()).toBeNull();
  });
});
