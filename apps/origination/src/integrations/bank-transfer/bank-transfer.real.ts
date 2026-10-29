// Банкны corporate gateway — бодит холболтын SKELETON.
// Банк тус бүрийн (Хаан, Голомт, ХХБ, Төрийн, Хас…) API баримт, credential байхгүй тул protocol-ыг ТААМАГЛАЖ зохиохгүй (docs/04 "Хүний оролцоо" #1).
import { requireEnv } from '../../shared/integration-mode';
import type { IntegrationMode } from '@los/contracts';
import { ProviderNotImplementedError } from '../payment-provider/provider-errors';
import type { BankGatewayPort, IncomingTransfer, ListIncomingRequest, NameCheckRequest, NameCheckResult, TransferRequest, TransferResult } from './bank-transfer.client';

// TODO(банкны API баримт ирсний дараа): банк тус бүрийн adapter (name-check, statement/incoming list, payout) хэрэгжүүлж fetch stub-тай тест бичнэ.
const REQUIRED_ENV = ['BANK_GATEWAY_BASE_URL', 'BANK_GATEWAY_CLIENT_ID', 'BANK_GATEWAY_SECRET'];

export class RealBankGateway implements BankGatewayPort {
  readonly mode: IntegrationMode = 'real';
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  isAvailable(): boolean { return false; }
  unavailableReason(): 'NOT_CONFIGURED' | 'NOT_IMPLEMENTED' { return REQUIRED_ENV.every((n) => !!this.env[n]) ? 'NOT_IMPLEMENTED' : 'NOT_CONFIGURED'; }

  private guard(): never {
    requireEnv('bank-transfer', REQUIRED_ENV, this.env); // дутуу бол IntegrationNotConfiguredError
    throw new ProviderNotImplementedError('Банк', 'Банкны бодит холболт хараахан хэрэгжээгүй байна (банк тус бүрийн corporate gateway-ийн баримт, credential хүлээгдэж байна)');
  }

  nameCheck(_req: NameCheckRequest): Promise<NameCheckResult> { return Promise.resolve().then(() => this.guard()); }
  listIncomingTransfers(_req: ListIncomingRequest): Promise<IncomingTransfer[]> { return Promise.resolve().then(() => this.guard()); }
  transfer(_req: TransferRequest): Promise<TransferResult> { return Promise.resolve().then(() => this.guard()); }
}
