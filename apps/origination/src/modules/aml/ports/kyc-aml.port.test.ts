import { describe, expect, it } from 'vitest';
import { DomainError, InternalHttpClient } from '@los/nest-common';
import type { AmlScreeningResult, RequestContext } from '@los/contracts';
import { HttpKycAmlPort } from './kyc-aml.port';

// origination → kyc sync REST (CLAUDE.md §3.2.2; docs/05-compliance-aml.md §7). Fail-closed (G1): kyc хүрэхгүй бол хэзээ ч «цэвэр» гэж үзэхгүй.
const ctx: RequestContext = { userId: 'u1', roles: ['OFFICER'], branchId: 'b1', orgId: 'org-1', customerId: null, correlationId: 'corr-1' };
const ENV = { KYC_URL: 'http://kyc.test' } as NodeJS.ProcessEnv;

interface Call { url: URL; init: RequestInit & { headers: Record<string, string> } }
function harness(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: URL, init: RequestInit) => {
    const call = { url, init } as Call;
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { calls, port: new HttpKycAmlPort(new InternalHttpClient({ fetchFn, env: ENV, sleep: async () => undefined })) };
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const RESULT: AmlScreeningResult = {
  id: 'scr-1', orgId: 'org-1', customerId: 'c1', applicationId: 'a1', trigger: 'APPLICATION', status: 'CLEAR', blocking: false, riskScore: 0, riskLevel: 'LOW', riskFactors: [],
  subjectName: 'Номин', registerNoMasked: 'УБ******01', hits: [], listVersions: { UN_SC: '2026-10', FATF: '2026-10', INTERNAL_BLACKLIST: 'live' }, screenedAt: '2026-11-18T09:00:00.000Z', screenedBy: 'u1',
};
const REQ = { orgId: 'org-1', customerId: 'c1', applicationId: 'a1', borrowerRole: 'PRIMARY' as const, trigger: 'APPLICATION' as const, subject: { subjectType: 'INDIVIDUAL' as const, registerNo: 'УБ90000001', firstName: 'Номин' } };

async function codeOf(p: Promise<unknown>): Promise<{ code: string; status: number; details: unknown }> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    const d = e as DomainError;
    const body = d.getResponse() as { code: string; details?: unknown };
    return { code: body.code, status: d.getStatus(), details: body.details };
  }
  throw new Error('expected rejection');
}

describe('HttpKycAmlPort.screen', () => {
  it('POST /api/aml/screen (ctx толгойтой) → AmlScreeningResult', async () => {
    const h = harness(() => json(RESULT, 201));
    await expect(h.port.screen(ctx, REQ)).resolves.toEqual(RESULT);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url.toString()).toBe('http://kyc.test/api/aml/screen');
    expect(h.calls[0].init.method).toBe('POST');
    expect(h.calls[0].init.headers['x-org-id']).toBe('org-1');
    expect(h.calls[0].init.headers['x-correlation-id']).toBe('corr-1');
    expect(JSON.parse(String(h.calls[0].init.body))).toMatchObject({ customerId: 'c1', applicationId: 'a1', trigger: 'APPLICATION', borrowerRole: 'PRIMARY' });
  });

  it('kyc 503 (жагсаалт уншигдахгүй) → 503 AML_SCREENING_UNAVAILABLE, retryable; POST-ийг давтахгүй', async () => {
    const h = harness(() => json({ code: 'UNAVAILABLE', message: 'x' }, 503));
    expect(await codeOf(h.port.screen(ctx, REQ))).toMatchObject({ code: 'AML_SCREENING_UNAVAILABLE', status: 503, details: { retryable: true } });
    expect(h.calls).toHaveLength(1);
  });

  it('сүлжээний алдаа / timeout → 503 AML_SCREENING_UNAVAILABLE', async () => {
    const h = harness(() => { throw new TypeError('fetch failed'); });
    expect(await codeOf(h.port.screen(ctx, REQ))).toMatchObject({ code: 'AML_SCREENING_UNAVAILABLE', status: 503 });
  });

  it('хариу гэрээнд нийцэхгүй → 503 AML_SCREENING_UNAVAILABLE (хэзээ ч цэвэр гэж үзэхгүй)', async () => {
    const h = harness(() => json({ status: 'CLEAR' }, 201));
    expect(await codeOf(h.port.screen(ctx, REQ))).toMatchObject({ code: 'AML_SCREENING_UNAVAILABLE', status: 503 });
  });

  it('kyc 400 (субъект хүчингүй) → 422 AML_SUBJECT_INVALID, дахин оролдох шаардлагагүй', async () => {
    const h = harness(() => json({ code: 'BAD_REQUEST', message: 'Validation failed' }, 400));
    expect(await codeOf(h.port.screen(ctx, REQ))).toMatchObject({ code: 'AML_SUBJECT_INVALID', status: 422, details: { retryable: false } });
  });

  it('kyc 409 (зэрэгцээ шалгалт / өөр identity) → 409 AML_SCREENING_STALE', async () => {
    const h = harness(() => json({ code: 'CONFLICT', message: 'x' }, 409));
    expect(await codeOf(h.port.screen(ctx, REQ))).toMatchObject({ code: 'AML_SCREENING_STALE', status: 409 });
  });

  it('kyc 401/403 (тохиргооны алдаа) → 503 AML_SCREENING_UNAVAILABLE (fail-closed)', async () => {
    const h = harness(() => json({ code: 'FORBIDDEN', message: 'x' }, 403));
    expect(await codeOf(h.port.screen(ctx, REQ))).toMatchObject({ code: 'AML_SCREENING_UNAVAILABLE', status: 503 });
  });
});

describe('HttpKycAmlPort.latest', () => {
  it('GET /api/aml/customers/:id/latest (id-г encode хийнэ)', async () => {
    const h = harness(() => json(RESULT));
    await expect(h.port.latest(ctx, 'c/1')).resolves.toEqual(RESULT);
    expect(h.calls[0].url.pathname).toBe('/api/aml/customers/c%2F1/latest');
    expect(h.calls[0].init.method).toBe('GET');
  });

  it('404 (шалгалт байхгүй) → null', async () => {
    const h = harness(() => json({ code: 'NOT_FOUND', message: 'No screening for this customer' }, 404));
    await expect(h.port.latest(ctx, 'c1')).resolves.toBeNull();
  });

  it('5xx → нэг удаа давтаад (idempotent GET) 503 AML_SCREENING_UNAVAILABLE', async () => {
    const h = harness(() => json({}, 500));
    expect(await codeOf(h.port.latest(ctx, 'c1'))).toMatchObject({ code: 'AML_SCREENING_UNAVAILABLE', status: 503 });
    expect(h.calls).toHaveLength(2);
  });
});
