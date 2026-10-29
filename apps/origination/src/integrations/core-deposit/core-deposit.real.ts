import { requireEnv } from '../../shared/integration-mode';
import { CoreDepositNotImplementedError } from './core-deposit.errors';
import type { CoreDepositPort, DepositAccountBalance, ListDepositBalancesRequest } from './core-deposit.port';

export const CORE_DEPOSIT_REQUIRED_ENV = ['CORE_DEPOSIT_API_URL', 'CORE_DEPOSIT_API_KEY'];

/**
 * Core-ийн депозит дансны жинхэнэ холболт.
 * TODO(docs/04 "Хүний оролцоо" #1): Core-ийн API-ын баримт, credential (CORE_DEPOSIT_API_URL, CORE_DEPOSIT_API_KEY) гараагүй тул
 * protocol-ыг таамаглаж зохиогоогүй. Баримт ирэхэд `listBalances`-ийг энд хэрэгжүүлнэ (олон харилцагчийг багцлан, timeout 15с —
 * CLAUDE.md §3.1; 5xx/сүлжээ → дахин оролдоно).
 */
export class RealCoreDepositPort implements CoreDepositPort {
  readonly mode = 'real' as const;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async listBalances(_req: ListDepositBalancesRequest): Promise<DepositAccountBalance[]> {
    requireEnv('core-deposit', CORE_DEPOSIT_REQUIRED_ENV, this.env); // тохиргоо дутуу бол IntegrationNotConfiguredError
    throw new CoreDepositNotImplementedError('Core депозит дансны интеграци хараахан хэрэгжээгүй байна: Core-ийн API-ын баримт, credential шаардлагатай (docs/04 "Хүний оролцоо" #1)');
  }
}
