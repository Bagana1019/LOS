import { PortalCustomerLookup, PortalProfile } from '@los/contracts';
import { PortalError } from '../../common/portal-error';
import type { AnonymousContext, CallContext } from '../../common/request-context';
import { InternalHttpClient } from '../internal-http.client';
import type { CustomerDirectoryPort } from './customer-directory.port';

const BASE = '/api/internal/portal/customers';

/** origination `/api/internal/portal/customers/*` (docs/05-portal-bff.md §6). */
export class RealCustomerDirectory implements CustomerDirectoryPort {
  constructor(private readonly http: InternalHttpClient) {}

  async lookupForLogin(input: { registerNo: string; phone: string }, ctx: AnonymousContext): Promise<PortalCustomerLookup | null> {
    try {
      return await this.http.json({
        method: 'POST',
        path: `${BASE}/lookup`,
        ctx,
        body: input,
        schema: PortalCustomerLookup,
        notFound: 'NOT_FOUND',
      });
    } catch (err) {
      // 404 = таарах харилцагч байхгүй — алдаа биш, null
      if (err instanceof PortalError && err.code === 'NOT_FOUND') return null;
      throw err;
    }
  }

  getProfile(ctx: CallContext): Promise<PortalProfile> {
    return this.http.json({ method: 'GET', path: `${BASE}/me`, ctx, schema: PortalProfile });
  }
}
