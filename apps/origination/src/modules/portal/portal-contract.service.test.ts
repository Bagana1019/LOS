import { describe, expect, it } from 'vitest';
import type { RequestContext } from '@los/contracts';
import { HttpDmsContractFiles, PORTAL_DMS_SERVICE_USER } from './portal-contract.service';

// Review (phase 3): dms no longer accepts a customer context, and must not — origination checks ownership first,
// then fetches the file as itself (service identity), never forwarding X-Customer-Id.
describe('HttpDmsContractFiles', () => {
  it('fetches the contract as the origination service, not as the customer', async () => {
    const calls: { service: string; path: string; ctx: RequestContext }[] = [];
    const http = { get: async (service: string, path: string, o: { ctx: RequestContext }) => { calls.push({ service, path, ctx: o.ctx }); return Buffer.from('%PDF-1.7'); } };
    const ctx: RequestContext = { userId: null, roles: ['CUSTOMER'], branchId: null, orgId: 'org-1', customerId: 'cust-1', correlationId: 'corr-1' };
    await new HttpDmsContractFiles(http as never).fetchPdf(ctx, 'file 1');
    expect(calls).toHaveLength(1);
    expect(calls[0].service).toBe('dms');
    expect(calls[0].path).toBe('/api/files/file%201/content');
    expect(calls[0].ctx).toEqual({ userId: PORTAL_DMS_SERVICE_USER, roles: [], branchId: null, orgId: 'org-1', customerId: null, correlationId: 'corr-1' });
  });
});
