import { createHash } from 'node:crypto';
import { CoreLoanError, type CoreLoanPort, type OpenLoanRequest, type OpenLoanResult } from './core-loan.port';

/** DEMO: deterministic. `coreLoanId = CL-<sha256(idempotencyKey)[0..10]>`. Данс нь `0000`-оор төгссөн бол Core татгалзана (алдааны замыг шалгахад). */
export class MockCoreLoanPort implements CoreLoanPort {
  readonly mode = 'mock' as const;
  readonly calls: OpenLoanRequest[] = [];
  /** H1: нээгдсэн данс (idempotencyKey → coreLoanId) — `findLoan`-д. Instance бүрт тусдаа (тест тусгаарлалт). */
  private readonly opened = new Map<string, string>();
  /** Тестийн hook (H1 race): true бол Core хүсэлтийг хүлээж аваад timeout буцаана, данс нь `flushLateOpens()` хүртэл `findLoan`-д харагдахгүй. */
  delayOpens = false;
  private readonly late = new Map<string, string>();
  async openLoan(req: OpenLoanRequest): Promise<OpenLoanResult> {
    this.calls.push(req);
    if (req.account.accountNo.endsWith('0000')) throw new CoreLoanError('CORE_REJECTED', 'Core: данс нээх хүсэлтийг татгалзлаа (DEMO)');
    const coreLoanId = this.opened.get(req.idempotencyKey) ?? `CL-${createHash('sha256').update(req.idempotencyKey).digest('hex').slice(0, 10).toUpperCase()}`;
    if (this.delayOpens && !this.opened.has(req.idempotencyKey)) {
      this.late.set(req.idempotencyKey, coreLoanId);
      throw new CoreLoanError('CORE_UNAVAILABLE', 'Core: timeout (DEMO — данс хожуу нээгдэнэ)');
    }
    this.opened.set(req.idempotencyKey, coreLoanId);
    return { coreLoanId };
  }
  /** Хожуу нээгдэх дансуудыг Core-д "дуусгана" (findLoan-д харагдана). */
  flushLateOpens(): void {
    for (const [key, id] of this.late) this.opened.set(key, id);
    this.late.clear();
  }
  async findLoan(idempotencyKey: string): Promise<OpenLoanResult | null> {
    const coreLoanId = this.opened.get(idempotencyKey);
    return coreLoanId ? { coreLoanId } : null;
  }
}
