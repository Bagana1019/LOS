import type { PortalCustomerLookup, PortalProfile } from '@los/contracts';
import type { AnonymousContext, CallContext } from '../../common/request-context';
import type { MockLedger } from '../mock/mock-ledger';
import type { CustomerDirectoryPort } from './customer-directory.port';

export class MockCustomerDirectory implements CustomerDirectoryPort {
  constructor(private readonly ledger: MockLedger) {}

  async lookupForLogin(input: { registerNo: string; phone: string }, _ctx: AnonymousContext): Promise<PortalCustomerLookup | null> {
    return this.ledger.findCustomer(input.registerNo, input.phone);
  }

  async getProfile(ctx: CallContext): Promise<PortalProfile> {
    return this.ledger.profile(ctx.customerId);
  }
}
