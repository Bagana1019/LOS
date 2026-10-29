import { createHash } from 'node:crypto';
import type { CoreDepositPort, DepositAccountBalance, ListDepositBalancesRequest } from './core-deposit.port';

const cents = (n: number) => Math.round(n) / 100;

/**
 * Deterministic Core депозит mock (CLAUDE.md §3.2.7): үлдэгдэл, дансны дугаар, төлөв нь регистрээс (sha256) гарна —
 * ижил регистр → үргэлж ижил тоо. Жинхэнэ сүлжээ ашиглахгүй. Бүх харилцагчид MNT данс; ~1/3-д нь нэмэлт USD данс.
 */
export class MockCoreDepositPort implements CoreDepositPort {
  readonly mode = 'mock' as const;

  async listBalances(req: ListDepositBalancesRequest): Promise<DepositAccountBalance[]> {
    const out: DepositAccountBalance[] = [];
    for (const c of req.customers) out.push(...accountsFor(c.customerId, c.registerNo));
    return out;
  }
}

/** Регистрээс гарах дансууд (тестэд шууд ашиглана). */
export function accountsFor(customerId: string, registerNo: string): DepositAccountBalance[] {
  const h = createHash('sha256').update(`core-deposit-mock:${registerNo.trim().toUpperCase()}`).digest();
  const status = h[15] % 10 === 0 ? 'DORMANT' : 'ACTIVE';
  const mnt = cents((h.readUInt32BE(1) % 500_000_000) + (h[5] % 100)); // 0 … 5,000,000.99 ₮
  const mntHold = (h[10] % 5) * 1000; // барьцаалсан/хязгаарласан дүн
  const accounts: DepositAccountBalance[] = [
    { customerId, accountNo: accountNo(h, 11, '5'), currency: 'MNT', balance: mnt, availableBalance: Math.max(0, Math.round((mnt - mntHold) * 100) / 100), status },
  ];
  if (h[0] % 3 === 0) {
    const usd = cents((h.readUInt32BE(6) % 5_000_000) + (h[20] % 100)); // 0 … 50,000.99 $
    accounts.push({ customerId, accountNo: accountNo(h, 22, '6'), currency: 'USD', balance: usd, availableBalance: usd, status });
  }
  return accounts;
}

function accountNo(h: Buffer, offset: number, prefix: string): string {
  return prefix + String(h.readUInt32BE(offset) % 1_000_000_000).padStart(9, '0');
}
