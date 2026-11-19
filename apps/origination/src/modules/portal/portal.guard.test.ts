import { describe, expect, it } from 'vitest';
import { authorizePortal } from './portal.guard';
import { PortalHttpError } from './portal-errors';

// H8 / docs/05-portal-bff.md §6: дотоод маршрут зөвхөн portal-bff-ийн CUSTOMER (эсвэл lookup-д PORTAL_ANONYMOUS) контекстэд.
const CUSTOMER = { 'x-actor-type': 'CUSTOMER', 'x-customer-id': 'cust-1', 'x-roles': 'CUSTOMER', 'x-correlation-id': 'corr-1' };
const ANON = { 'x-actor-type': 'PORTAL_ANONYMOUS', 'x-correlation-id': 'corr-2' };
const env = (o: Record<string, string> = {}) => ({ DEFAULT_ORG_ID: 'org-1', ...o }) as NodeJS.ProcessEnv;

function rejection(fn: () => unknown): { status: number; code: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof PortalHttpError) return { status: e.getStatus(), code: e.code };
    throw e;
  }
  throw new Error('expected rejection');
}

describe('authorizePortal — customer routes', () => {
  it('accepts a CUSTOMER context and returns a customer-only request context', () => {
    const ctx = authorizePortal(CUSTOMER, { anonymous: false }, env());
    expect(ctx).toEqual({ userId: null, roles: ['CUSTOMER'], branchId: null, orgId: 'org-1', customerId: 'cust-1', correlationId: 'corr-1' });
  });

  it('rejects a missing actor type', () => {
    const { 'x-actor-type': _drop, ...rest } = CUSTOMER;
    expect(rejection(() => authorizePortal(rest, { anonymous: false }, env())).status).toBe(401);
  });

  it('rejects an unknown actor type', () => {
    expect(rejection(() => authorizePortal({ ...CUSTOMER, 'x-actor-type': 'STAFF' }, { anonymous: false }, env())).status).toBe(401);
  });

  it('rejects CUSTOMER without X-Customer-Id', () => {
    const { 'x-customer-id': _drop, ...rest } = CUSTOMER;
    expect(rejection(() => authorizePortal(rest, { anonymous: false }, env())).status).toBe(401);
  });

  it.each(['../x', 'a b', 'x'.repeat(65), 'кирилл', ''])('rejects a malformed customer id %j', (id) => {
    expect(rejection(() => authorizePortal({ ...CUSTOMER, 'x-customer-id': id }, { anonymous: false }, env())).status).toBe(401);
  });

  it.each([['ADMIN'], ['CUSTOMER,ADMIN'], ['OFFICER'], ['']])('rejects roles %j (must be exactly CUSTOMER)', (roles) => {
    expect(rejection(() => authorizePortal({ ...CUSTOMER, 'x-roles': roles }, { anonymous: false }, env())).status).toBe(403);
  });

  it('refuses any staff context (X-User-Id), even with a valid customer actor', () => {
    expect(rejection(() => authorizePortal({ ...CUSTOMER, 'x-user-id': 'admin-1' }, { anonymous: false }, env()))).toEqual({ status: 403, code: 'STAFF_CONTEXT_REFUSED' });
  });

  it('refuses a staff branch header', () => {
    expect(rejection(() => authorizePortal({ ...CUSTOMER, 'x-branch-id': 'b-1' }, { anonymous: false }, env())).status).toBe(403);
  });

  it('rejects PORTAL_ANONYMOUS on a customer route', () => {
    expect(rejection(() => authorizePortal(ANON, { anonymous: false }, env())).status).toBe(401);
  });

  it('rejects when no org can be resolved', () => {
    expect(rejection(() => authorizePortal(CUSTOMER, { anonymous: false }, {} as NodeJS.ProcessEnv)).status).toBe(401);
  });
});

describe('authorizePortal — anonymous login lookup', () => {
  it('accepts PORTAL_ANONYMOUS without a customer id', () => {
    const ctx = authorizePortal(ANON, { anonymous: true }, env());
    expect(ctx).toMatchObject({ userId: null, roles: [], customerId: null, orgId: 'org-1' });
  });

  it('rejects PORTAL_ANONYMOUS that carries a customer id', () => {
    expect(rejection(() => authorizePortal({ ...ANON, 'x-customer-id': 'cust-1' }, { anonymous: true }, env())).status).toBe(401);
  });

  it('rejects PORTAL_ANONYMOUS that carries roles', () => {
    expect(rejection(() => authorizePortal({ ...ANON, 'x-roles': 'ADMIN' }, { anonymous: true }, env())).status).toBe(401);
  });

  it('rejects a CUSTOMER actor on the anonymous-only route', () => {
    expect(rejection(() => authorizePortal(CUSTOMER, { anonymous: true }, env())).status).toBe(401);
  });

  it('refuses staff on the anonymous route too', () => {
    expect(rejection(() => authorizePortal({ ...ANON, 'x-user-id': 'u' }, { anonymous: true }, env())).status).toBe(403);
  });
});

describe('authorizePortal — internal token', () => {
  const secret = 's'.repeat(32);

  it('accepts the matching X-Internal-Token', () => {
    expect(authorizePortal({ ...CUSTOMER, 'x-internal-token': secret }, { anonymous: false }, env({ INTERNAL_AUTH_SECRET: secret })).customerId).toBe('cust-1');
  });

  it.each([undefined, '', 'wrong', `${secret}x`])('rejects token %j when a secret is configured', (token) => {
    const h = token === undefined ? CUSTOMER : { ...CUSTOMER, 'x-internal-token': token };
    expect(rejection(() => authorizePortal(h, { anonymous: false }, env({ INTERNAL_AUTH_SECRET: secret })))).toEqual({ status: 401, code: 'INVALID_INTERNAL_TOKEN' });
  });

  it('fails closed in production when no secret is configured', () => {
    expect(rejection(() => authorizePortal(CUSTOMER, { anonymous: false }, env({ NODE_ENV: 'production' }))).status).toBe(401);
  });

  it('generates a correlation id when the supplied one is unsafe', () => {
    const ctx = authorizePortal({ ...CUSTOMER, 'x-correlation-id': 'bad id\n' }, { anonymous: false }, env());
    expect(ctx.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
