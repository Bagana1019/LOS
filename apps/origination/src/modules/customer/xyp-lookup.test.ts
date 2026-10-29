import { SEED } from '@los/database';
import { InternalHttpClient } from '@los/nest-common';
import { describe, expect, it, vi } from 'vitest';
import { KycXypLookup } from './xyp-lookup';

const ctx = { userId: SEED.users.officerA.id, roles: ['OFFICER'], branchId: SEED.branches.head.id, orgId: SEED.org.id, customerId: null, correlationId: 'corr-1' };
const citizen = {
  registerNo: 'УБ90010112', customerType: 'INDIVIDUAL', lastName: 'Болд', firstName: 'Сарнай', gender: 'FEMALE', birthDate: '1990-01-01', maritalStatus: 'MARRIED', familySize: 3,
  activitySector: null, address: { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: '5-р хороо', detail: 'x' }, fetchedAt: '2026-01-01T00:00:00.000Z',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const lookup = (fetchFn: typeof fetch) => new KycXypLookup(new InternalHttpClient({ fetchFn, env: {} }));

describe('KycXypLookup (origination → kyc)', () => {
  it('POSTs the register to kyc with the identity headers and a 15s timeout, and validates the reply', async () => {
    const fetchFn = vi.fn(async () => json(200, citizen)) as unknown as typeof fetch;
    const out = await lookup(fetchFn).fetchCitizen(ctx, 'УБ90010112');
    expect(out.firstName).toBe('Сарнай');
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [URL, RequestInit];
    expect(url.pathname).toBe('/api/xyp/citizen');
    expect(url.port).toBe('4002');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ registerNo: 'УБ90010112' });
    expect(init.headers).toMatchObject({ 'x-user-id': ctx.userId, 'x-org-id': SEED.org.id, 'x-roles': 'OFFICER', 'x-correlation-id': 'corr-1' });
  });

  it('passes kyc 4xx through with its code, so the UI can say "not found in XYP"', async () => {
    const fetchFn = (async () => json(404, { code: 'XYP_NOT_FOUND', message: 'ХУР-д олдсонгүй' })) as unknown as typeof fetch;
    await expect(lookup(fetchFn).fetchCitizen(ctx, 'УБ00000000')).rejects.toMatchObject({ code: 'XYP_NOT_FOUND', status: 404 });
  });

  it('keeps the XYP outage / not-implemented codes so the UI can offer manual entry', async () => {
    const down = vi.fn(async () => json(503, { code: 'XYP_UNAVAILABLE', message: 'ХУР түр ажиллахгүй' })) as unknown as typeof fetch;
    await expect(lookup(down).fetchCitizen(ctx, 'УБ90010112')).rejects.toMatchObject({ code: 'XYP_UNAVAILABLE', status: 503, message: 'ХУР түр ажиллахгүй' });
    expect(down).toHaveBeenCalledTimes(1); // POST дахин оролдохгүй
    const real = (async () => json(501, { code: 'INTEGRATION_NOT_IMPLEMENTED', message: 'real горим' })) as unknown as typeof fetch;
    await expect(lookup(real).fetchCitizen(ctx, 'УБ90010112')).rejects.toMatchObject({ code: 'INTEGRATION_NOT_IMPLEMENTED', status: 501 });
  });

  it('maps any other kyc failure to 502 and a timeout to 504', async () => {
    const broken = (async () => json(500, { code: 'INTERNAL' })) as unknown as typeof fetch;
    await expect(lookup(broken).fetchCitizen(ctx, 'УБ90010112')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', status: 502 });
    const slow = (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
    await expect(lookup(slow).fetchCitizen(ctx, 'УБ90010112')).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT', status: 504 });
  });

  it('rejects a reply that does not match the contract', async () => {
    const fetchFn = (async () => json(200, { registerNo: 'УБ90010112' })) as unknown as typeof fetch;
    // ЗЭЗ-д «маягтын алдаа» (400) биш, дотоод сервисийн алдаа (502) харагдана
    await expect(lookup(fetchFn).fetchCitizen(ctx, 'УБ90010112')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', status: 502 });
  });
});
