import { createHash } from 'node:crypto';
import { CoreLoanError, type CoreLoanPort, type OpenLoanRequest, type OpenLoanResult } from './core-loan.port';

/** DEMO: deterministic. `coreLoanId = CL-<sha256(idempotencyKey)[0..10]>`. Данс нь `0000`-оор төгссөн бол Core татгалзана (алдааны замыг шалгахад). */
export class MockCoreLoanPort implements CoreLoanPort {
  readonly mode = 'mock' as const;
  readonly calls: OpenLoanRequest[] = [];
  async openLoan(req: OpenLoanRequest): Promise<OpenLoanResult> {
    this.calls.push(req);
    if (req.account.accountNo.endsWith('0000')) throw new CoreLoanError('CORE_REJECTED', 'Core: данс нээх хүсэлтийг татгалзлаа (DEMO)');
    return { coreLoanId: `CL-${createHash('sha256').update(req.idempotencyKey).digest('hex').slice(0, 10).toUpperCase()}` };
  }
}
