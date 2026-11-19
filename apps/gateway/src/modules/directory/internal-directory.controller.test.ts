import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CTX_HEADERS, DIRECTORY_TOKEN_HEADER, OrgDirectory } from '@los/contracts';
import { InternalDirectoryController } from './internal-directory.controller';

// Origination-ийн Excel экспортод зориулсан дотоод лавлах: JWT-гүй (service-to-service). ЗӨВХӨН бие даасан GATEWAY_DIRECTORY_TOKEN (X-Directory-Token)-оор.
// INTERNAL_AUTH_SECRET-ийг gateway proxy бүх backend-д тарааж өгдөг тул энэ замд ХЭЗЭЭ Ч хүчинтэй биш. Токен тохируулаагүй бол хаалттай (503).
const SNAPSHOT: OrgDirectory = { branches: { b1: 'Төв салбар' }, users: { u1: 'Бат Болд' } };
const TOKEN = 'directory-token-for-tests-0123';
const INTERNAL_SECRET = 'internal-secret-for-tests';
const ORG = { [CTX_HEADERS.orgId]: 'org-1' };

function make() {
  const service = { get: vi.fn(async (_orgId: string) => SNAPSHOT) };
  return { controller: new InternalDirectoryController(service as never), service };
}
const call = async (c: InternalDirectoryController, headers: Record<string, unknown>) => {
  try { return { ok: true as const, value: await c.get({ headers } as never) }; } catch (e) { const ex = e as { getStatus(): number; getResponse(): { code: string } }; return { ok: false as const, status: ex.getStatus(), code: ex.getResponse().code }; }
};

describe('InternalDirectoryController', () => {
  const saved = { dir: process.env.GATEWAY_DIRECTORY_TOKEN, internal: process.env.INTERNAL_AUTH_SECRET, node: process.env.NODE_ENV };
  const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  beforeEach(() => { process.env.GATEWAY_DIRECTORY_TOKEN = TOKEN; process.env.INTERNAL_AUTH_SECRET = INTERNAL_SECRET; });
  afterEach(() => { restore('GATEWAY_DIRECTORY_TOKEN', saved.dir); restore('INTERNAL_AUTH_SECRET', saved.internal); restore('NODE_ENV', saved.node); });

  it('зөв X-Directory-Token + X-Org-Id → ЗӨВХӨН тухайн байгууллагын лавлах (OrgDirectory схемд нийцнэ)', async () => {
    const { controller, service } = make();
    const r = await call(controller, { [DIRECTORY_TOKEN_HEADER]: TOKEN, ...ORG });
    expect(r).toEqual({ ok: true, value: SNAPSHOT });
    expect(OrgDirectory.safeParse(r.ok && r.value).success).toBe(true);
    expect(service.get).toHaveBeenCalledTimes(1);
    expect(service.get).toHaveBeenCalledWith('org-1');
  });

  it.each([['тохируулаагүй', undefined], ['хоосон', ''], ['зөвхөн хоосон зай', '   ']])('GATEWAY_DIRECTORY_TOKEN %s → 503 DIRECTORY_TOKEN_NOT_CONFIGURED, лавлах уншихгүй (fail closed)', async (_n, value) => {
    if (value === undefined) delete process.env.GATEWAY_DIRECTORY_TOKEN; else process.env.GATEWAY_DIRECTORY_TOKEN = value;
    const { controller, service } = make();
    for (const h of [{ ...ORG }, { [DIRECTORY_TOKEN_HEADER]: '', ...ORG }, { [DIRECTORY_TOKEN_HEADER]: '   ', ...ORG }, { [DIRECTORY_TOKEN_HEADER]: TOKEN, ...ORG }]) {
      expect(await call(controller, h)).toMatchObject({ ok: false, status: 503, code: 'DIRECTORY_TOKEN_NOT_CONFIGURED' });
    }
    expect(service.get).not.toHaveBeenCalled();
  });

  it('хуучин дотоод токен (X-Internal-Token = INTERNAL_AUTH_SECRET) энэ замд хүчингүй → 401', async () => {
    const { controller, service } = make();
    expect(await call(controller, { [CTX_HEADERS.internalToken]: INTERNAL_SECRET, ...ORG })).toMatchObject({ ok: false, status: 401, code: 'INVALID_DIRECTORY_TOKEN' });
    // буруу directory token-той бол дотоод токен аврахгүй
    expect(await call(controller, { [CTX_HEADERS.internalToken]: INTERNAL_SECRET, [DIRECTORY_TOKEN_HEADER]: 'nope', ...ORG })).toMatchObject({ ok: false, status: 401 });
    expect(service.get).not.toHaveBeenCalled();
  });

  it('INTERNAL_AUTH_SECRET-ийн утгыг X-Directory-Token-д өгсөн ч хүчингүй (хоёр нууц тусдаа)', async () => {
    const { controller, service } = make();
    expect(await call(controller, { [DIRECTORY_TOKEN_HEADER]: INTERNAL_SECRET, ...ORG })).toMatchObject({ ok: false, status: 401, code: 'INVALID_DIRECTORY_TOKEN' });
    expect(service.get).not.toHaveBeenCalled();
  });

  it.each([
    ['токен байхгүй', {}],
    ['буруу токен', { [DIRECTORY_TOKEN_HEADER]: 'nope' }],
    ['урт нь өөр токен', { [DIRECTORY_TOKEN_HEADER]: `${TOKEN}-extra` }],
    ['угтвар токен', { [DIRECTORY_TOKEN_HEADER]: TOKEN.slice(0, -1) }],
    ['массив токен', { [DIRECTORY_TOKEN_HEADER]: [TOKEN, TOKEN] }],
    ['JWT Bearer (токен биш)', { authorization: 'Bearer abc' }],
  ])('%s → 401 INVALID_DIRECTORY_TOKEN, лавлах уншихгүй', async (_n, headers) => {
    const { controller, service } = make();
    expect(await call(controller, { ...headers, ...ORG })).toMatchObject({ ok: false, status: 401, code: 'INVALID_DIRECTORY_TOKEN' });
    expect(service.get).not.toHaveBeenCalled();
  });

  it.each([
    ['байхгүй', undefined], ['хоосон', ''], ['хоосон зай', '   '], ['зайтай', 'org 1'], ['зам', '../org-1'], ['инжекц', "x' OR '1'='1"],
    ['шинэ мөр', 'org-1\n'], ['хэт урт (65)', 'a'.repeat(65)], ['массив', ['org-1', 'org-2']],
  ])('X-Org-Id %s → 400 INVALID_ORG (бүх байгууллагыг нэгтгэж буцаахгүй)', async (_n, org) => {
    const { controller, service } = make();
    expect(await call(controller, { [DIRECTORY_TOKEN_HEADER]: TOKEN, ...(org === undefined ? {} : { [CTX_HEADERS.orgId]: org }) })).toMatchObject({ ok: false, status: 400, code: 'INVALID_ORG' });
    expect(service.get).not.toHaveBeenCalled();
  });

  it('UUID / cuid хэлбэрийн байгууллагын id хүлээн авна', async () => {
    const { controller, service } = make();
    for (const org of ['0b3e6c1e-7f3d-4c53-9a53-3f5e1d2c4b6a', 'org_01HZX', 'ckxyz123']) {
      expect((await call(controller, { [DIRECTORY_TOKEN_HEADER]: TOKEN, [CTX_HEADERS.orgId]: org })).ok).toBe(true);
    }
    expect(service.get).toHaveBeenCalledTimes(3);
  });

  it('production-д сул токен (богино / .env.example-ийн загвар) → тохируулаагүй мэт 503 (bootstrap-ээс гадна хүсэлт бүрт давхар хамгаалалт)', async () => {
    process.env.NODE_ENV = 'production';
    const { controller, service } = make();
    for (const weak of ['short-token', 'dev-directory-token-change-me-please']) {
      process.env.GATEWAY_DIRECTORY_TOKEN = weak;
      expect(await call(controller, { [DIRECTORY_TOKEN_HEADER]: weak, ...ORG })).toMatchObject({ ok: false, status: 503, code: 'DIRECTORY_TOKEN_NOT_CONFIGURED' });
    }
    process.env.GATEWAY_DIRECTORY_TOKEN = TOKEN;
    expect((await call(controller, { [DIRECTORY_TOKEN_HEADER]: TOKEN, ...ORG })).ok).toBe(true);
    expect(service.get).toHaveBeenCalledTimes(1);
  });
});
