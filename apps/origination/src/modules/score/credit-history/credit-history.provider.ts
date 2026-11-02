import { resolveIntegrationMode } from '../../../shared/integration-mode';
import type { CreditHistoryPort } from './credit-history.port';
import { KycCreditHistory } from './kyc-credit-history';
import { MockCreditHistory } from './mock-credit-history';

/** CLAUDE.md §3.2.7: `INTEGRATION_MODE` (эсвэл `INTEGRATION_MODE_CREDIT_HISTORY`)-ээр mock ⇄ real. Анхдагч — mock (DEMO). */
export function createCreditHistory(env: NodeJS.ProcessEnv = process.env): CreditHistoryPort {
  return resolveIntegrationMode('credit-history', env) === 'real' ? new KycCreditHistory() : new MockCreditHistory();
}
