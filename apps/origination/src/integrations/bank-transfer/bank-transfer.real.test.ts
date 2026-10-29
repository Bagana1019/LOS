import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError } from '../../shared/integration-mode';
import { ProviderNotImplementedError } from '../payment-provider/provider-errors';
import { createBankGateway } from './bank-transfer.provider';
import { MockBankGateway } from './bank-transfer.mock';
import { RealBankGateway } from './bank-transfer.real';

const FULL_ENV = { BANK_GATEWAY_BASE_URL: 'https://bank.example', BANK_GATEWAY_CLIENT_ID: 'id', BANK_GATEWAY_SECRET: 's' };

describe('RealBankGateway (skeleton)', () => {
  it('тохиргоо дутуу: IntegrationNotConfiguredError, NOT_CONFIGURED', async () => {
    const g = new RealBankGateway({});
    expect(g.isAvailable()).toBe(false);
    expect(g.unavailableReason()).toBe('NOT_CONFIGURED');
    await expect(g.nameCheck({ bankCode: 'KHAN', accountNo: '1234', holderName: 'x' })).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    await expect(g.listIncomingTransfers({ since: new Date(), accountNo: '1' })).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
  });

  it('тохиргоо бүрэн ч хэрэгжээгүй: ProviderNotImplementedError (монгол мессеж), NOT_IMPLEMENTED', async () => {
    const g = new RealBankGateway(FULL_ENV);
    expect(g.isAvailable()).toBe(false);
    expect(g.unavailableReason()).toBe('NOT_IMPLEMENTED');
    const err = await g.transfer({ fromAccountNo: '1', toBankCode: 'K', toAccountNo: '2', toHolderName: 'x', amount: 1, currency: 'MNT', description: 'd', reference: 'r' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNotImplementedError);
    expect(err.message).toContain('хэрэгжээгүй');
  });

  it('provider: INTEGRATION_MODE-оор mock/real сонгоно', () => {
    const clock = { now: () => new Date() };
    expect(createBankGateway(clock, {})).toBeInstanceOf(MockBankGateway);
    expect(createBankGateway(clock, { INTEGRATION_MODE: 'real' })).toBeInstanceOf(RealBankGateway);
    expect(createBankGateway(clock, { INTEGRATION_MODE: 'real', INTEGRATION_MODE_BANK_TRANSFER: 'mock' })).toBeInstanceOf(MockBankGateway);
  });
});
