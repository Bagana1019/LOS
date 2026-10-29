import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { CoreDepositNotImplementedError } from './core-deposit.errors';
import { accountsFor, MockCoreDepositPort } from './core-deposit.mock';
import { createCoreDepositPort } from './core-deposit.provider';
import { RealCoreDepositPort } from './core-deposit.real';

const regs = Array.from({ length: 60 }, (_, i) => `УБ${String(90000000 + i * 7919)}`);

describe('MockCoreDepositPort (deterministic)', () => {
  it('ижил регистр → ижил данс/үлдэгдэл; регистрийн том/жижиг үсэг, зайг тооцохгүй', async () => {
    const port = new MockCoreDepositPort();
    const a = await port.listBalances({ asOf: '2026-10-28', customers: [{ customerId: 'c1', registerNo: 'УБ90000001' }] });
    const b = await port.listBalances({ asOf: '2026-01-01', customers: [{ customerId: 'c1', registerNo: ' уб90000001 ' }] });
    expect(a.length).toBeGreaterThanOrEqual(1);
    expect(b).toEqual(a);
  });

  it('өөр регистр → өөр дансны дугаар; харилцагч бүрт ≥ 1 MNT данс; бүх тоо 2 оронтой, сөрөггүй', () => {
    const accountNos = new Set<string>();
    for (const r of regs) {
      const accs = accountsFor('c', r);
      expect(accs[0].currency).toBe('MNT');
      for (const a of accs) {
        expect(a.accountNo).toMatch(/^[56]\d{9}$/);
        accountNos.add(a.accountNo);
        expect(a.balance).toBeGreaterThanOrEqual(0);
        expect(a.availableBalance).toBeGreaterThanOrEqual(0);
        expect(a.availableBalance).toBeLessThanOrEqual(a.balance);
        expect(Math.round(a.balance * 100) / 100).toBe(a.balance);
        expect(['ACTIVE', 'DORMANT']).toContain(a.status);
      }
    }
    expect(accountNos.size).toBeGreaterThan(regs.length); // зарим нь USD данстай
  });

  it('нэмэлт USD данстай харилцагч байдаг (~1/3) ба MNT-ээс өөр данстай', () => {
    const withUsd = regs.filter((r) => accountsFor('c', r).some((a) => a.currency === 'USD'));
    expect(withUsd.length).toBeGreaterThan(5);
    expect(withUsd.length).toBeLessThan(regs.length / 2 + 10);
  });

  it('customerId-г хадгална; хоосон жагсаалтад хоосон', async () => {
    const port = new MockCoreDepositPort();
    expect(await port.listBalances({ asOf: '2026-10-28', customers: [] })).toEqual([]);
    const rows = await port.listBalances({ asOf: '2026-10-28', customers: [{ customerId: 'x', registerNo: 'УБ1' }, { customerId: 'y', registerNo: 'УБ2' }] });
    expect(new Set(rows.map((r) => r.customerId))).toEqual(new Set(['x', 'y']));
  });
});

describe('RealCoreDepositPort', () => {
  const req = { asOf: '2026-10-28', customers: [{ customerId: 'c1', registerNo: 'УБ90000001' }] };

  it('тохиргоо дутуу бол IntegrationNotConfiguredError', async () => {
    await expect(new RealCoreDepositPort({}).listBalances(req)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
  });

  it('тохиргоотой ч гэсэн NotImplemented (протокол зохиогоогүй)', async () => {
    const real = new RealCoreDepositPort({ CORE_DEPOSIT_API_URL: 'https://core.example', CORE_DEPOSIT_API_KEY: 'k' });
    await expect(real.listBalances(req)).rejects.toBeInstanceOf(CoreDepositNotImplementedError);
  });
});

describe('createCoreDepositPort', () => {
  it('анхдагч mock; INTEGRATION_MODE_CORE_DEPOSIT=real бол real', () => {
    expect(createCoreDepositPort({}).mode).toBe('mock');
    expect(createCoreDepositPort({ INTEGRATION_MODE: 'real' }).mode).toBe('real');
    expect(createCoreDepositPort({ INTEGRATION_MODE: 'real', INTEGRATION_MODE_CORE_DEPOSIT: 'mock' }).mode).toBe('mock');
    expect(() => createCoreDepositPort({ INTEGRATION_MODE: 'bogus' })).toThrow();
  });
});
