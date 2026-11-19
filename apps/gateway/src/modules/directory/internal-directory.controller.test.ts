import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CTX_HEADERS, OrgDirectory } from '@los/contracts';
import { InternalDirectoryController } from './internal-directory.controller';

// Origination-ийн Excel экспортод зориулсан дотоод лавлах: JWT-гүй (service-to-service) тул ЗӨВХӨН дотоод токеноор, токен тохируулаагүй бол хаалттай.
const SNAPSHOT: OrgDirectory = { branches: { b1: 'Төв салбар' }, users: { u1: 'Бат Болд' } };
const SECRET = 'internal-secret-for-tests';

function make() {
  const service = { get: vi.fn(async (_orgId: string) => SNAPSHOT) };
  return { controller: new InternalDirectoryController(service as never), service };
}
const req = (headers: Record<string, unknown>) => ({ headers }) as never;
const call = async (c: InternalDirectoryController, headers: Record<string, unknown>) => {
  try { return { ok: true as const, value: await c.get(req(headers)) }; } catch (e) { const ex = e as { getStatus(): number; getResponse(): { code: string } }; return { ok: false as const, status: ex.getStatus(), code: ex.getResponse().code }; }
};

describe('InternalDirectoryController', () => {
  const saved = process.env.INTERNAL_AUTH_SECRET;
  beforeEach(() => { process.env.INTERNAL_AUTH_SECRET = SECRET; });
  afterEach(() => { if (saved === undefined) delete process.env.INTERNAL_AUTH_SECRET; else process.env.INTERNAL_AUTH_SECRET = saved; });

  it('зөв дотоод токен + X-Org-Id → тухайн байгууллагын лавлах (OrgDirectory схемд нийцнэ)', async () => {
    const { controller, service } = make();
    const r = await call(controller, { [CTX_HEADERS.internalToken]: SECRET, [CTX_HEADERS.orgId]: 'org-1' });
    expect(r).toEqual({ ok: true, value: SNAPSHOT });
    expect(OrgDirectory.safeParse(r.ok && r.value).success).toBe(true);
    expect(service.get).toHaveBeenCalledTimes(1);
    expect(service.get).toHaveBeenCalledWith('org-1');
  });

  it('токен тохируулаагүй (INTERNAL_AUTH_SECRET хоосон) → 503, лавлах уншихгүй (fail closed: токенгүй хүн org-ийн нэр авч болохгүй)', async () => {
    delete process.env.INTERNAL_AUTH_SECRET;
    const { controller, service } = make();
    const r = await call(controller, { [CTX_HEADERS.orgId]: 'org-1' });
    expect(r).toMatchObject({ ok: false, status: 503, code: 'INTERNAL_AUTH_NOT_CONFIGURED' });
    process.env.INTERNAL_AUTH_SECRET = '';
    expect(await call(controller, { [CTX_HEADERS.internalToken]: '', [CTX_HEADERS.orgId]: 'org-1' })).toMatchObject({ ok: false, status: 503 });
    expect(service.get).not.toHaveBeenCalled();
  });

  it.each([
    ['токен байхгүй', {}],
    ['буруу токен', { [CTX_HEADERS.internalToken]: 'nope' }],
    ['урт нь өөр токен', { [CTX_HEADERS.internalToken]: `${SECRET}-extra` }],
    ['массив токен', { [CTX_HEADERS.internalToken]: [SECRET, SECRET] }],
    ['JWT Bearer (дотоод токен биш)', { authorization: 'Bearer abc' }],
  ])('%s → 401 INVALID_INTERNAL_TOKEN, лавлах уншихгүй', async (_n, headers) => {
    const { controller, service } = make();
    expect(await call(controller, { ...headers, [CTX_HEADERS.orgId]: 'org-1' })).toMatchObject({ ok: false, status: 401, code: 'INVALID_INTERNAL_TOKEN' });
    expect(service.get).not.toHaveBeenCalled();
  });

  it('X-Org-Id байхгүй / хоосон → 400 MISSING_ORG (бүх байгууллагыг нэгтгэж буцаахгүй)', async () => {
    const { controller, service } = make();
    for (const org of [undefined, '', '   ']) {
      expect(await call(controller, { [CTX_HEADERS.internalToken]: SECRET, ...(org === undefined ? {} : { [CTX_HEADERS.orgId]: org }) })).toMatchObject({ ok: false, status: 400, code: 'MISSING_ORG' });
    }
    expect(service.get).not.toHaveBeenCalled();
  });
});
