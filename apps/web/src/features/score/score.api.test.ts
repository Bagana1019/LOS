import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API, ApiError } from '../../lib/api';
import { t } from '../../lib/i18n';
import { calculateScore, fetchScoreOverview, previewBody, previewScore, selectScoreMethod } from './score.api';
import { describeScoreError } from './score.utils';
import { APP_ID, TERMS, emptyOverview, makeOverview, previewResponse } from './testing/fixtures';

// Gateway зөвхөн `/api/<service>/*`-ийг дамжуулдаг: origination-ий score endpoint-ууд `/api/origination/applications/:id/score…`.
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown, status = 200) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const fail = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, init, body: init.body === undefined ? undefined : JSON.parse(init.body as string) };
};

describe('GET …/score', () => {
  it('gateway-н /origination угтвартай, id-г encode хийнэ, ScoreOverview-ээр шалгана', async () => {
    const overview = makeOverview();
    ok(overview);
    const got = await fetchScoreOverview('a/b 1');
    expect(lastCall().url).toBe(`${API}/origination/applications/a%2Fb%201/score`);
    expect(lastCall().init.method).toBe('GET');
    expect(got.calculation?.result.methods).toHaveLength(3);
  });

  it('тооцоолол байхгүй (calculation: null) overview-г зөвшөөрнө', async () => {
    ok(emptyOverview());
    const got = await fetchScoreOverview(APP_ID);
    expect(got.calculation).toBeNull();
    expect(got.sosco).toBeNull();
  });

  it('гэрээнээс зөрсөн хариуг ZodError-оор татгалзаж, INVALID_RESPONSE гэж тайлбарлана', async () => {
    ok({ applicationId: APP_ID, editable: true });
    const error = await fetchScoreOverview(APP_ID).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ZodError' });
    expect(describeScoreError(error, t).message).toBe(t('score.error.INVALID_RESPONSE'));
  });

  it('AbortSignal дамжуулна', async () => {
    ok(makeOverview());
    const controller = new AbortController();
    await fetchScoreOverview(APP_ID, controller.signal);
    expect(lastCall().init.signal).toBe(controller.signal);
  });
});

describe('POST …/score/preview', () => {
  it('slider-ийн гурван утгыг явуулна; ScorePreviewResponse-оор шалгана', async () => {
    const body = previewBody({ amount: 12_500_000, termMonths: 18, interestRate: 21.5 });
    expect(body).toEqual({ amount: 12_500_000, termMonths: 18, interestRate: 21.5 });
    ok(previewResponse({ amount: 12_500_000, termMonths: 18, interestRate: 21.5 }));
    const got = await previewScore(APP_ID, body);
    expect(lastCall().url).toBe(`${API}/origination/applications/${APP_ID}/score/preview`);
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().body).toEqual(body);
    expect(got.terms.termMonths).toBe(18);
    expect(got.result.loan.monthlyPayment).toBeGreaterThan(0);
  });

  it('хүчингүй оролтыг (сөрөг дүн) сүлжээнд гаргахгүй', async () => {
    await expect(previewScore(APP_ID, { amount: -1 })).rejects.toMatchObject({ name: 'ZodError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('422 OUT_OF_PRODUCT_LIMITS → ApiError(code) → монгол мессеж', async () => {
    fail(422, { code: 'OUT_OF_PRODUCT_LIMITS', message: 'x' });
    const error = await previewScore(APP_ID, previewBody(TERMS)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: 'OUT_OF_PRODUCT_LIMITS' });
    expect(describeScoreError(error, t).message).toBe(t('score.error.OUT_OF_PRODUCT_LIMITS'));
  });
});

describe('POST …/score/calculate', () => {
  it('body-гүй POST; ScoreOverview буцаана', async () => {
    ok(makeOverview());
    const got = await calculateScore(APP_ID);
    expect(lastCall().url).toBe(`${API}/origination/applications/${APP_ID}/score/calculate`);
    expect(lastCall().init.method).toBe('POST');
    expect(lastCall().init.body).toBeUndefined();
    expect(got.applicationId).toBe(APP_ID);
  });

  it('503 SCORING_UNAVAILABLE → дахин оролдох боломжтой алдаа', async () => {
    fail(503, { code: 'SCORING_UNAVAILABLE', message: 'x' });
    const error = await calculateScore(APP_ID).catch((e: unknown) => e);
    expect(describeScoreError(error, t)).toMatchObject({ code: 'SCORING_UNAVAILABLE', retryable: true });
  });
});

describe('PUT …/score/selection', () => {
  it('арга + тайлбар (trim хийгдсэн); PUT', async () => {
    ok(makeOverview());
    await selectScoreMethod(APP_ID, { method: 'B_BUSINESS', reason: '  Бизнесийн орлого найдвартай  ' });
    expect(lastCall().url).toBe(`${API}/origination/applications/${APP_ID}/score/selection`);
    expect(lastCall().init.method).toBe('PUT');
    expect(lastCall().body).toEqual({ method: 'B_BUSINESS', reason: 'Бизнесийн орлого найдвартай' });
  });

  it('тайлбар заавал биш (Q-M8-8)', async () => {
    ok(makeOverview());
    await selectScoreMethod(APP_ID, { method: 'A_SALARY' });
    expect(lastCall().body).toEqual({ method: 'A_SALARY' });
  });

  it('500 тэмдэгтээс урт тайлбар, үл мэдэгдэх арга сүлжээнд гарахгүй', async () => {
    await expect(selectScoreMethod(APP_ID, { method: 'A_SALARY', reason: 'я'.repeat(501) })).rejects.toMatchObject({ name: 'ZodError' });
    await expect(selectScoreMethod(APP_ID, { method: 'X' as 'A_SALARY' })).rejects.toMatchObject({ name: 'ZodError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('409 CALCULATION_STALE, 422 METHOD_NOT_APPLICABLE', async () => {
    fail(409, { code: 'CALCULATION_STALE', message: 'x' });
    const stale = await selectScoreMethod(APP_ID, { method: 'A_SALARY' }).catch((e: unknown) => e);
    expect(describeScoreError(stale, t).message).toBe(t('score.error.CALCULATION_STALE'));
    fail(422, { code: 'METHOD_NOT_APPLICABLE', message: 'x' });
    const na = await selectScoreMethod(APP_ID, { method: 'B_BUSINESS' }).catch((e: unknown) => e);
    expect(describeScoreError(na, t).message).toBe(t('score.error.METHOD_NOT_APPLICABLE'));
  });
});
