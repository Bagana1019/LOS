import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalHttpClient, DomainError } from '@los/nest-common';
import type { RequestContext, ScoreRequest } from '@los/contracts';
import { HttpScoringClient, SCORING_TIMEOUT_MS, createScoringClient } from './scoring.client';
import { calculationRecord, soscoResponse, soscoSummary, underwriteResult } from './testing/scoring-fixtures';

const ctx: RequestContext = { userId: 'u1', roles: ['OFFICER'], branchId: 'b1', orgId: 'o1', customerId: null, correlationId: 'corr-1' };
const POLICY = { maxDti: 0.55, minDscr: 1.25, maxLtv: 0.7, weightThreshold: 0.7 };
const request: ScoreRequest = {
  applicationId: 'app/1', amount: 12_345_678, termMonths: 12, interestRate: 24, monthlyPayment: 1_167_521.6, salaryMonthly: 3_000_000, businessNcfMonthly: 0,
  householdExpenseMonthly: 0, existingDebtServiceMonthly: 500_000, collateralValueTotal: 0, collateralRequired: false, policy: POLICY,
};

interface Seen { method: string; url: string; headers: IncomingHttpHeaders; body: unknown }
type Reply = { status: number; body?: unknown; delayMs?: number; headers?: Record<string, string> };

let servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers = [];
});

async function start(handler: (seen: Seen, hit: number) => Reply) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      seen.push(entry);
      const r = handler(entry, seen.length);
      setTimeout(() => {
        res.statusCode = r.status;
        res.setHeader('content-type', 'application/json');
        for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
        res.end(r.body === undefined ? '' : JSON.stringify(r.body));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, env: { SCORING_URL: url } as NodeJS.ProcessEnv };
}

const clientFor = (env: NodeJS.ProcessEnv, timeoutMs?: number) => new HttpScoringClient(new InternalHttpClient({ env, sleep: async () => {} }), timeoutMs);

describe('HttpScoringClient · маршрут, толгой, хариуны гэрээ', () => {
  it('preview: POST /api/underwrite/preview — ScoreRequest-ийг хэвээр илгээж, identity/correlation толгой дамжуулж, UnderwriteResult задлана', async () => {
    const result = underwriteResult(request);
    const s = await start(() => ({ status: 200, body: result }));
    await expect(clientFor(s.env).preview(ctx, request)).resolves.toEqual(result);
    expect(s.seen[0]).toMatchObject({ method: 'POST', url: '/api/underwrite/preview', body: request });
    expect(s.seen[0]!.headers).toMatchObject({ 'x-user-id': 'u1', 'x-roles': 'OFFICER', 'x-branch-id': 'b1', 'x-org-id': 'o1', 'x-correlation-id': 'corr-1' });
  });

  it('calculate: POST /api/underwrite — UnderwritePersistRequest + CalculationRecord', async () => {
    const record = calculationRecord(request);
    const s = await start(() => ({ status: 200, body: record }));
    const body = { request, customerId: 'cust-1', selectedMethod: 'B_BUSINESS' as const, selectionReason: 'Бизнес давамгайлна' };
    await expect(clientFor(s.env).calculate(ctx, body)).resolves.toEqual(record);
    expect(s.seen[0]).toMatchObject({ method: 'POST', url: '/api/underwrite', body });
  });

  it('latest: GET /api/underwrite/applications/:id/latest (id кодлогдоно); CALCULATION_NOT_FOUND → null', async () => {
    const record = calculationRecord(request);
    const found = await start(() => ({ status: 200, body: record }));
    await expect(clientFor(found.env).latest(ctx, 'app/1')).resolves.toEqual(record);
    expect(found.seen[0]).toMatchObject({ method: 'GET', url: '/api/underwrite/applications/app%2F1/latest' });

    const none = await start(() => ({ status: 404, body: { code: 'CALCULATION_NOT_FOUND', message: 'Тооцоолол олдсонгүй' } }));
    await expect(clientFor(none.env).latest(ctx, 'app-1')).resolves.toBeNull();
  });

  it('select: PUT …/selection → CalculationRecord', async () => {
    const record = calculationRecord(request, { selectedMethod: 'C_COMBINED', selection: 'MANUAL', selectionReason: 'Хосолсон' });
    const s = await start(() => ({ status: 200, body: record }));
    await expect(clientFor(s.env).select(ctx, 'app-1', { method: 'C_COMBINED', reason: 'Хосолсон' })).resolves.toEqual(record);
    expect(s.seen[0]).toMatchObject({ method: 'PUT', url: '/api/underwrite/applications/app-1/selection', body: { method: 'C_COMBINED', reason: 'Хосолсон' } });
  });

  it('select: бүтэн CalculationRecord биш (204) хариу ирвэл сүүлийн тооцоолол уншина', async () => {
    const record = calculationRecord(request, { selectedMethod: 'B_BUSINESS', selection: 'MANUAL' });
    const s = await start((seen) => (seen.method === 'PUT' ? { status: 204 } : { status: 200, body: record }));
    await expect(clientFor(s.env).select(ctx, 'app-1', { method: 'B_BUSINESS' })).resolves.toEqual(record);
    expect(s.seen.map((x) => `${x.method} ${x.url}`)).toEqual(['PUT /api/underwrite/applications/app-1/selection', 'GET /api/underwrite/applications/app-1/latest']);
  });

  it('markStale: POST …/stale {reason}; хариуны бие үл хамаарна; CALCULATION_NOT_FOUND нь алдаа биш', async () => {
    for (const reply of [{ status: 204 }, { status: 200, body: { ok: true } }, { status: 404, body: { code: 'CALCULATION_NOT_FOUND', message: 'x' } }] as Reply[]) {
      const s = await start(() => reply);
      await expect(clientFor(s.env).markStale(ctx, 'app-1', { reason: 'LOAN_TERMS_CHANGED' })).resolves.toBeUndefined();
      expect(s.seen[0]).toMatchObject({ method: 'POST', url: '/api/underwrite/applications/app-1/stale', body: { reason: 'LOAN_TERMS_CHANGED' } });
    }
  });

  it('scoreSosco: POST /api/sosco/score (persist) → SoscoScoreResponse', async () => {
    const response = soscoResponse({ score: 640, grade: 'C' });
    const s = await start(() => ({ status: 200, body: response }));
    const body = { applicationId: 'app-1', customerId: 'cust-1', persist: true, input: { ficoScore: 700, dtiPercent: 30, incomeReliability: null, pendingSuspiciousCount: null, activeLoanCount: 0, overdueHistoryMonths: 0, ltv: null } };
    await expect(clientFor(s.env).scoreSosco(ctx, body)).resolves.toEqual(response);
    expect(s.seen[0]).toMatchObject({ method: 'POST', url: '/api/sosco/score', body });
  });

  it('latestSosco: GET /api/sosco/results/latest?applicationId&customerId — SoscoSummary эсвэл SoscoScoreResponse (customerId нэмнэ), 404/хоосон → null', async () => {
    const summary = soscoSummary('cust-1', { score: 810, grade: 'A' });
    const a = await start(() => ({ status: 200, body: summary }));
    await expect(clientFor(a.env).latestSosco(ctx, 'app-1', 'cust-1')).resolves.toEqual(summary);
    expect(a.seen[0]).toMatchObject({ method: 'GET', url: '/api/sosco/results/latest?applicationId=app-1&customerId=cust-1' });

    const response = soscoResponse({ score: 500, grade: 'D' });
    const b = await start(() => ({ status: 200, body: response }));
    const { modelId: _modelId, ...rest } = response;
    await expect(clientFor(b.env).latestSosco(ctx, 'app-1', 'cust-1')).resolves.toEqual({ ...rest, customerId: 'cust-1' });

    for (const reply of [{ status: 404, body: { code: 'NOT_FOUND', message: 'x' } }, { status: 404 }, { status: 200 }, { status: 200, body: null }] as Reply[]) {
      const none = await start(() => reply);
      await expect(clientFor(none.env).latestSosco(ctx, 'app-1', 'cust-1')).resolves.toBeNull();
    }
  });

  it('createScoringClient: SCORING_URL-ээс; анхдагч timeout 3с (CLAUDE.md §3.1); ctx-ийн толгойд INTERNAL_AUTH_SECRET нэмнэ', async () => {
    expect(SCORING_TIMEOUT_MS).toBe(3_000);
    const s = await start(() => ({ status: 200, body: underwriteResult(request) }));
    await createScoringClient({ ...s.env, INTERNAL_AUTH_SECRET: 's3cret' }).preview(ctx, request);
    expect(s.seen[0]!.headers['x-internal-token']).toBe('s3cret');
  });
});

describe('HttpScoringClient · алдааны хөрвүүлэлт', () => {
  beforeEach(() => { vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });

  it('5xx → SCORING_UNAVAILABLE 503 (UPSTREAM_ERROR); POST дахин оролдогдохгүй (давхар тооцоолол үүсэхгүй)', async () => {
    for (const call of [
      (c: HttpScoringClient) => c.preview(ctx, request),
      (c: HttpScoringClient) => c.calculate(ctx, { request, customerId: 'c' }),
      (c: HttpScoringClient) => c.scoreSosco(ctx, { applicationId: 'a', customerId: 'c', persist: true, input: { ficoScore: null, dtiPercent: null, incomeReliability: null, pendingSuspiciousCount: null, activeLoanCount: null, overdueHistoryMonths: null, ltv: null } }),
      (c: HttpScoringClient) => c.select(ctx, 'a', { method: 'A_SALARY' }),
      (c: HttpScoringClient) => c.markStale(ctx, 'a', { reason: 'x' }),
    ]) {
      const s = await start(() => ({ status: 500, body: { message: 'boom' } }));
      const error = await call(clientFor(s.env)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: 'SCORING_UNAVAILABLE', status: 503, details: { reason: 'UPSTREAM_ERROR' } });
      expect(s.seen).toHaveLength(1);
    }
  });

  it('idempotent GET нэг удаа дахин оролдогдоно (InternalHttpClient)', async () => {
    const record = calculationRecord(request);
    const s = await start((_seen, hit) => (hit === 1 ? { status: 503 } : { status: 200, body: record }));
    await expect(clientFor(s.env).latest(ctx, 'app-1')).resolves.toEqual(record);
    expect(s.seen).toHaveLength(2);
  });

  it('timeout → SCORING_UNAVAILABLE (TIMEOUT)', async () => {
    const s = await start(() => ({ status: 200, body: underwriteResult(request), delayMs: 300 }));
    await expect(clientFor(s.env, 40).preview(ctx, request)).rejects.toMatchObject({ code: 'SCORING_UNAVAILABLE', status: 503, details: { reason: 'TIMEOUT' } });
  });

  it('холбогдож чадахгүй → SCORING_UNAVAILABLE (UNREACHABLE)', async () => {
    const s = await start(() => ({ status: 200 }));
    const dead = s.env;
    await Promise.all(servers.splice(0).map((x) => new Promise<void>((r) => x.close(() => r()))));
    await expect(clientFor(dead).preview(ctx, request)).rejects.toMatchObject({ code: 'SCORING_UNAVAILABLE', details: { reason: 'UNREACHABLE' } });
  });

  it('гэрээнд нийцээгүй хариу (талбар дутуу / буруу төрөл / муу JSON) → SCORING_UNAVAILABLE (INVALID_RESPONSE), утгыг логлохгүй', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { methods: _methods, ...broken } = underwriteResult(request);
    for (const body of [broken, { ...underwriteResult(request), methods: 'x' }, 'not json at all', []]) {
      const s = await start(() => ({ status: 200, body }));
      await expect(clientFor(s.env).preview(ctx, request)).rejects.toMatchObject({ code: 'SCORING_UNAVAILABLE', details: { reason: 'INVALID_RESPONSE' } });
    }
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('violates the contract');
    expect(logged).not.toContain('12345678');
  });

  it('latest: CALCULATION_NOT_FOUND-аас өөр 404 (маршрут алга) → SCORING_UNAVAILABLE; тооцоололгүй record хэлбэр буруу → INVALID_RESPONSE', async () => {
    const s = await start(() => ({ status: 404, body: { code: 'NOT_FOUND', message: 'Cannot GET' } }));
    await expect(clientFor(s.env).latest(ctx, 'app-1')).rejects.toMatchObject({ code: 'SCORING_UNAVAILABLE' });
    const bad = await start(() => ({ status: 200, body: { id: 'x' } }));
    await expect(clientFor(bad.env).latest(ctx, 'app-1')).rejects.toMatchObject({ code: 'SCORING_UNAVAILABLE', details: { reason: 'INVALID_RESPONSE' } });
  });

  it.each([
    [409, 'CALCULATION_STALE', 'Тооцоолол хуучирсан'],
    [422, 'METHOD_NOT_APPLICABLE', 'Сонгосон арга хэрэглэгдэхгүй', { reasons: [{ code: 'NO_BUSINESS_INCOME' }] }],
    [422, 'NO_SELECTABLE_METHOD', 'Сонгох арга алга'],
    [404, 'CALCULATION_NOT_FOUND', 'Тооцоолол олдсонгүй'],
    [404, 'SOSCO_MODEL_NOT_FOUND', 'Идэвхтэй загвар алга'],
    [422, 'INVALID_SOSCO_MODEL', 'Загвар буруу'],
    [422, 'LOAN_TERMS_MISSING', 'Нөхцөл дутуу'],
    [409, 'SOME_FUTURE_CONFLICT', 'Шинэ зөрчил'], // мэдэгдээгүй код ч 409/422 бол бизнесийн зөрчил — дамжина
  ])('scoring-ийн домэйн алдаа %i %s өөрчлөгдөхгүй дамжина', async (status, code, message, details?: { reasons: Array<{ code: string }> }) => {
    const s = await start(() => ({ status, body: { code, message, ...(details ? { details } : {}) } }));
    const error = await clientFor(s.env).select(ctx, 'app-1', { method: 'B_BUSINESS' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code, status });
    expect((error as DomainError).message).toBe(message);
    if (details) expect((error as DomainError).details).toEqual(details);
  });

  it.each([[400, 'VALIDATION_FAILED'], [401, 'UNAUTHENTICATED'], [401, 'INVALID_INTERNAL_TOKEN'], [403, 'FORBIDDEN'], [405, 'METHOD_NOT_ALLOWED']])(
    'гэрээ/тохиргооны алдаа %i %s → SCORING_UNAVAILABLE 503 (401/403 нь web-ийн сесс дууссан гэж ойлгогдохгүй)',
    async (status, code) => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const s = await start(() => ({ status, body: { code, message: 'x' } }));
      await expect(clientFor(s.env).calculate(ctx, { request, customerId: 'c' })).rejects.toMatchObject({ code: 'SCORING_UNAVAILABLE', status: 503, details: { reason: 'REJECTED' } });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('12345678'); // хүсэлтийн бие логт орохгүй
    },
  );

  it('redirect дагахгүй: ctx толгой (internal token) өөр хост руу алдагдахгүй', async () => {
    const other = await start(() => ({ status: 200, body: underwriteResult(request) }));
    const first = await start(() => ({ status: 307, headers: { location: `${other.url}/api/underwrite/preview` } }));
    await expect(createScoringClient({ ...first.env, INTERNAL_AUTH_SECRET: 's3cret' }).preview(ctx, request)).rejects.toMatchObject({ code: 'SCORING_UNAVAILABLE' });
    expect(other.seen).toHaveLength(0);
  });

});
