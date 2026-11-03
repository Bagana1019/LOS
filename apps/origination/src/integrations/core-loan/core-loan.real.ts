import { requireEnv } from '../../shared/integration-mode';
import { CoreLoanError, type CoreLoanPort, type OpenLoanRequest, type OpenLoanResult } from './core-loan.port';

export const CORE_LOAN_REQUIRED_ENV = ['CORE_LOAN_API_URL', 'CORE_LOAN_API_KEY'];

/**
 * Core-ийн зээлийн данс нээх жинхэнэ холболт.
 * TODO(docs/04 "Хүний оролцоо" #1): Core API-ийн баримт, credential (CORE_LOAN_API_URL, CORE_LOAN_API_KEY) гараагүй тул protocol-ыг таамаглаж зохиогоогүй.
 * Хэрэгжүүлэхдээ: timeout 15с (CLAUDE.md §3.1), `idempotencyKey`-г Idempotency-Key толгойгоор, 5xx/сүлжээнд CORE_UNAVAILABLE.
 */
export class RealCoreLoanPort implements CoreLoanPort {
  readonly mode = 'real' as const;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async openLoan(_req: OpenLoanRequest): Promise<OpenLoanResult> {
    requireEnv('core-loan', CORE_LOAN_REQUIRED_ENV, this.env);
    throw new CoreLoanError('NOT_IMPLEMENTED', 'Core зээлийн данс нээх интеграци хараахан хэрэгжээгүй байна (Core API баримт шаардлагатай)');
  }
}
