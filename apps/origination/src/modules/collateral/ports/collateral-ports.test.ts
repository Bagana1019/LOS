import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainError, InternalHttpClient, UpstreamError } from '@los/nest-common';
import type { RequestContext, SuggestValuationRequest } from '@los/contracts';
import { FakeKycAssetsPort } from '../testing/fake-kyc-assets.port';
import { FakeValuationPort } from '../testing/fake-valuation.port';
import { HttpFilePort } from './file.port';
import { HttpKycAssetsPort } from './kyc-assets.port';
import { HttpValuationPort } from './valuation.port';
import { mapUpstreamError } from './upstream';

const ctx: RequestContext = { userId: 'u1', roles: ['OFFICER'], branchId: 'b1', orgId: 'org-1', customerId: null, correlationId: 'corr-1' };
const ENV = { KYC_URL: 'http://kyc.test', VALUATION_URL: 'http://valuation.test', DMS_URL: 'http://dms.test' } as NodeJS.ProcessEnv;

interface Call { url: URL; init: RequestInit & { headers: Record<string, string> } }
function harness(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: URL, init: RequestInit) => {
    const call = { url, init } as Call;
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  const http = new InternalHttpClient({ fetchFn, env: ENV, sleep: async () => undefined });
  return { calls, http };
}
const ok = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const body = (c: Call): unknown => JSON.parse(String(c.init.body));

const request: SuggestValuationRequest = {
  collateralId: 'c1', applicationId: 'a1', productId: 'p1', assetType: 'VEHICLE', description: { plateNo: '1234УБА' }, productHaircutRate: 0.7, externalValuationThreshold: 100_000_000, validityDays: 90,
} as SuggestValuationRequest;

afterEach(() => vi.restoreAllMocks());

describe('HttpKycAssetsPort', () => {
  it('fetchAssets: POST /api/xyp/assets, 15с timeout, ctx толгой, хариуг гэрээгээр шалгана', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { calls, http } = harness(() => ok({ properties: [], vehicles: [], fetchedAt: '2026-10-29T03:00:00.000Z' }));
    const res = await new HttpKycAssetsPort(http).fetchAssets(ctx, 'УЕ00000001');
    expect(res.fetchedAt).toBe('2026-10-29T03:00:00.000Z');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.href).toBe('http://kyc.test/api/xyp/assets');
    expect(calls[0]!.init.method).toBe('POST');
    expect(body(calls[0]!)).toEqual({ registerNo: 'УЕ00000001' });
    expect(calls[0]!.init.headers).toMatchObject({ 'x-user-id': 'u1', 'x-correlation-id': 'corr-1' });
    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it('хариу гэрээнд нийцэхгүй -> 502 UpstreamError (ZodError задрахгүй)', async () => {
    const { http } = harness(() => ok({ properties: 'x' }));
    const err = await new HttpKycAssetsPort(http).fetchAssets(ctx, 'УЕ00000001').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).getStatus()).toBe(502);
  });

  it('POST дахин оролдохгүй: 503 -> нэг л дуудлага', async () => {
    const { calls, http } = harness(() => ok({ code: 'XYP_UNAVAILABLE', message: 'ХУР түр ажиллахгүй' }, 503));
    const err = await new HttpKycAssetsPort(http).fetchAssets(ctx, 'УЕ00000001').catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    // зөвшөөрөгдсөн (хэрэглэгчид зориулсан) код нь монгол мессежтэйгээ дамжина
    expect(err).toBeInstanceOf(DomainError);
    expect(err).not.toBeInstanceOf(UpstreamError);
    expect((err as DomainError).code).toBe('XYP_UNAVAILABLE');
    expect((err as DomainError).getStatus()).toBe(503);
  });

  it('үл мэдэгдэх 5xx код дотоод агуулгыг дамжуулахгүй: 502 UpstreamError', async () => {
    const { http } = harness(() => ok({ code: 'SQL_BOOM', message: 'select * from secret' }, 500));
    const err = await new HttpKycAssetsPort(http).fetchAssets(ctx, 'УЕ00000001').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(JSON.stringify((err as UpstreamError).getResponse())).not.toContain('secret');
  });

  it('fetchProperty: XYP_NOT_FOUND (404) -> 422 REGISTRY_RECORD_NOT_FOUND', async () => {
    const { calls, http } = harness(() => ok({ code: 'XYP_NOT_FOUND', message: 'ХУР-д олдсонгүй' }, 404));
    const err = await new HttpKycAssetsPort(http).fetchProperty(ctx, 'P-1').catch((e: unknown) => e);
    expect(calls[0]!.url.pathname).toBe('/api/xyp/property');
    expect(body(calls[0]!)).toEqual({ propertyId: 'P-1' });
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('REGISTRY_RECORD_NOT_FOUND');
    expect((err as DomainError).getStatus()).toBe(422);
  });

  it('checkEncumbrance: POST /api/collateral-checks/encumbrance, үр дүнг гэрээгээр шалгана', async () => {
    const fake = new FakeKycAssetsPort();
    const result = await fake.checkEncumbrance(ctx, { assetType: 'VEHICLE', identifier: '1234УБА7' });
    const { calls, http } = harness(() => ok(result));
    const res = await new HttpKycAssetsPort(http).checkEncumbrance(ctx, { assetType: 'VEHICLE', identifier: '1234УБА7' });
    expect(res.status).toBe('ENCUMBERED');
    expect(calls[0]!.url.pathname).toBe('/api/collateral-checks/encumbrance');
    expect(body(calls[0]!)).toEqual({ assetType: 'VEHICLE', identifier: '1234УБА7' });
  });

  it('ENCUMBRANCE_UNAVAILABLE (fail closed) 503 нь монгол мессежтэй дамжина', async () => {
    const { http } = harness(() => ok({ code: 'ENCUMBRANCE_UNAVAILABLE', message: 'ЗМС холбогдохгүй байна' }, 503));
    const err = await new HttpKycAssetsPort(http).checkEncumbrance(ctx, { assetType: 'VEHICLE', identifier: 'x' }).catch((e: unknown) => e);
    expect((err as DomainError).code).toBe('ENCUMBRANCE_UNAVAILABLE');
  });
});

describe('HttpValuationPort', () => {
  it('suggest / save: POST + 15с timeout + гэрээгээр шалгана', async () => {
    const fake = new FakeValuationPort();
    const suggest = await fake.suggest(ctx, request);
    const save = await fake.save(ctx, { ...request, marketValue: 30_000_000 });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const h = harness((c) => ok(c.url.pathname.endsWith('/suggest') ? suggest : save));
    const port = new HttpValuationPort(h.http);
    expect((await port.suggest(ctx, request)).suggestion.marketValue).toBe(30_000_000);
    expect((await port.save(ctx, { ...request, marketValue: 30_000_000 } as never)).valuation.collateralValue).toBe(21_000_000);
    expect(h.calls.map((c) => `${c.init.method} ${c.url.pathname}`)).toEqual(['POST /api/valuate/collateral/suggest', 'POST /api/valuate/collateral']);
    expect(timeout.mock.calls.map((c) => c[0])).toEqual([15_000, 15_000]);
  });

  it('save: OVERRIDE_REASON_REQUIRED (422) монгол мессежтэй дамжина', async () => {
    const { http } = harness(() => ok({ code: 'OVERRIDE_REASON_REQUIRED', message: 'Шалтгаан бичнэ үү' }, 422));
    const err = await new HttpValuationPort(http).save(ctx, request as never).catch((e: unknown) => e);
    expect((err as DomainError).code).toBe('OVERRIDE_REASON_REQUIRED');
    expect((err as DomainError).getStatus()).toBe(422);
  });

  it('recordExternal: хоёр хариуны хэлбэрийг хоёуланг нь хүлээн авна', async () => {
    const fake = new FakeValuationPort();
    const record = await fake.recordExternal(ctx, { ...request, appraiser: 'Үнэлгээ ХХК', valuedAt: '2026-10-28', marketValue: 120_000_000, reportFileId: 'f1' } as never);
    const wrapped = new HttpValuationPort(harness(() => ok({ valuation: record, suggestion: null })).http);
    const bare = new HttpValuationPort(harness(() => ok(record)).http);
    expect((await wrapped.recordExternal(ctx, {} as never)).id).toBe(record.id);
    expect((await bare.recordExternal(ctx, {} as never)).id).toBe(record.id);
    const bad = new HttpValuationPort(harness(() => ok({ nope: true })).http);
    await expect(bad.recordExternal(ctx, {} as never)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('history: GET, 3с timeout, collateralId URL-д кодлогдоно, GET нэг удаа дахин оролдоно', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    let n = 0;
    const { calls, http } = harness(() => (++n === 1 ? ok({ code: 'X', message: 'x' }, 500) : ok({ items: [] })));
    const res = await new HttpValuationPort(http).history(ctx, 'a/b c');
    expect(res).toEqual({ items: [] });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.pathname).toBe('/api/valuate/collateral/a%2Fb%20c/history');
    expect(calls[0]!.init.method).toBe('GET');
    expect(timeout.mock.calls.every((c) => c[0] === 3_000)).toBe(true);
  });

  it('lookupVehicle: VEHICLE_NOT_FOUND (404) -> 422 REGISTRY_RECORD_NOT_FOUND', async () => {
    const { calls, http } = harness(() => ok({ code: 'VEHICLE_NOT_FOUND', message: 'Олдсонгүй' }, 404));
    const err = await new HttpValuationPort(http).lookupVehicle(ctx, '1234УБА').catch((e: unknown) => e);
    expect(calls[0]!.url.pathname).toBe('/api/valuate/vehicle-lookup');
    expect((err as DomainError).code).toBe('REGISTRY_RECORD_NOT_FOUND');
    expect((err as DomainError).getStatus()).toBe(422);
  });

  it('timeout -> 504 UpstreamError', async () => {
    const http = new InternalHttpClient({ env: ENV, fetchFn: (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as unknown as typeof fetch, sleep: async () => undefined });
    const err = await new HttpValuationPort(http).suggest(ctx, request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).getStatus()).toBe(504);
  });
});

describe('HttpFilePort', () => {
  it('getMeta: GET /api/files/:id, 3с timeout; мета-г буцаана', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { calls, http } = harness(() => ok({ id: 'f1', name: 'a.pdf', mime: 'application/pdf', size: 10, extra: 'ignored' }));
    expect(await new HttpFilePort(http).getMeta(ctx, 'f1')).toEqual({ id: 'f1', name: 'a.pdf', mime: 'application/pdf', size: 10 });
    expect(calls[0]!.url.href).toBe('http://dms.test/api/files/f1');
    expect(timeout).toHaveBeenCalledWith(3_000);
  });

  it('404 -> null; өөр алдаа дамжина', async () => {
    expect(await new HttpFilePort(harness(() => ok({ code: 'FILE_NOT_FOUND', message: 'x' }, 404)).http).getMeta(ctx, 'f1')).toBeNull();
    await expect(new HttpFilePort(harness(() => ok({ code: 'FORBIDDEN', message: 'x' }, 403)).http).getMeta(ctx, 'f1')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(new HttpFilePort(harness(() => ok({}, 500)).http).getMeta(ctx, 'f1')).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('mapUpstreamError', () => {
  it('ZodError -> 502; DomainError хэвээр; зөвшөөрөгдөөгүй 5xx хэвээр', () => {
    const zod = Object.assign(new Error('z'), { name: 'ZodError' });
    expect(mapUpstreamError('kyc', zod)).toBeInstanceOf(UpstreamError);
    const d = new DomainError('X', 'y', 409);
    expect(mapUpstreamError('kyc', d)).toBe(d);
    const e = new UpstreamError('kyc', 500, 'm', 502, { code: 'XYP_UNAVAILABLE', message: 7 });
    expect(mapUpstreamError('kyc', e)).toBe(e);
  });
});
