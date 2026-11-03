import type { NdshSalaryResponse, NdshSalaryRow, RequestContext } from '@los/contracts';
import { DomainError } from '@los/nest-common';
import type { KycNdshPort } from '../ports/kyc-ndsh.port';

/** Тестийн НДШ: `rows`-ийг буцаана; `error`-той бол шидэнэ. */
export class FakeNdshPort implements KycNdshPort {
  rows: NdshSalaryRow[] = [];
  error: DomainError | null = null;
  registers: string[] = [];

  async fetchSalaries(_ctx: RequestContext, registerNo: string): Promise<NdshSalaryResponse> {
    this.registers.push(registerNo);
    if (this.error) throw this.error;
    return { fetchedAt: '2026-11-03T02:00:00.000Z', items: this.rows };
  }
}

/** Сүүлийн `n` сарын (2026-10-ээс эхлэн хойш) тогтмол цалин. */
export function monthlySalaries(n: number, salary: number, employer = 'Монгол Шуудан ХХК', lastYear = 2026, lastMonth = 10): NdshSalaryRow[] {
  return Array.from({ length: n }, (_, i) => {
    const ord = lastYear * 12 + (lastMonth - 1) - (n - 1 - i);
    return { employer, year: Math.floor(ord / 12), month: (ord % 12) + 1, salary, contributionPaid: Math.round(salary * 0.2) };
  });
}
