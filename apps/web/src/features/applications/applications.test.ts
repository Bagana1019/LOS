import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationStatus, IDEMPOTENCY_KEY_PATTERN, StepKey, type ApplicationStepView } from '@los/contracts';
import { API, ApiError } from '../../lib/api';
import { hasMessage } from '../../lib/i18n';
import * as api from './applications.api';
import { createIdempotencyKeyHolder, describeApplicationError, isStepOpen, newIdempotencyKey, resumeStep, shouldRotateIdempotencyKey, singleFlight, STATUS_TABS, stepHref } from './applications.utils';

const here = fileURLToPath(new URL('.', import.meta.url));

const step = (stepKey: StepKey, status: ApplicationStepView['status'], stage: 1 | 2 = 1): ApplicationStepView => ({ stepKey, stage, order: 1, status, required: true, completedAt: null, staleReason: null });

describe('төлөв, алхам', () => {
  it('табууд төлөвтэй 1:1 (9 таб), бүгд монгол нэртэй', () => {
    expect(STATUS_TABS).toEqual(ApplicationStatus);
    for (const s of ApplicationStatus) expect(hasMessage(`status.${s}`), s).toBe(true);
  });
  it('12 алхам бүр нэртэй, төлөв бүр тайлбартай', () => {
    for (const k of StepKey) expect(hasMessage(`application.step.${k}`), k).toBe(true);
    for (const s of ['LOCKED', 'PENDING', 'COMPLETED', 'STALE']) expect(hasMessage(`application.stepStatus.${s}`), s).toBe(true);
  });
  it('resumeStep: эхний бүрдээгүй 1-р үе шатны алхам; бүгд бүрдсэн бол шийдвэр', () => {
    expect(resumeStep([step('client', 'COMPLETED'), step('inquiry', 'PENDING'), step('income', 'PENDING')])).toBe('inquiry');
    expect(resumeStep([step('client', 'COMPLETED'), step('inquiry', 'STALE')])).toBe('inquiry');
    expect(resumeStep([step('client', 'COMPLETED'), step('contract', 'PENDING', 2)])).toBe('decision');
  });
  it('isStepOpen: LOCKED бол хаалттай', () => {
    expect(isStepOpen({ steps: [step('contract', 'LOCKED', 2)] }, 'contract')).toBe(false);
    expect(isStepOpen({ steps: [step('client', 'PENDING')] }, 'client')).toBe(true);
  });
  it('stepHref', () => expect(stepHref('a/b', 'client')).toBe('/los/loan-application/a%2Fb/client'));
  it('алдааны текст: мэдэгдэж буй код → i18n, үгүй бол fallback', () => {
    expect(describeApplicationError(new Error('x'), 'application.create.failed')).toBe('Хүсэлт үүсгэж чадсангүй');
  });
});

describe('gateway зам (`/api/origination/applications…`)', () => {
  let urls: Array<{ url: string; method?: string }>;
  beforeEach(() => {
    urls = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      urls.push({ url, method: init?.method });
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each<[string, () => Promise<unknown>, string, string]>([
    ['list', () => api.fetchApplications({ status: 'DRAFT', page: 2 }), '/applications?status=DRAFT&page=2', 'GET'],
    ['detail', () => api.fetchApplication('a1'), '/applications/a1', 'GET'],
    ['history', () => api.fetchApplicationHistory('a1'), '/applications/a1/history', 'GET'],
    ['create', () => api.createApplication({}), '/applications', 'POST'],
    ['submit', () => api.transitionApplication('a1', { to: 'SUBMITTED' }), '/applications/a1/transition', 'POST'],
  ])('%s', async (_n, call, path, method) => {
    await call();
    expect(urls[0].url).toBe(`${API}/origination${path}`);
    expect((urls[0].method ?? 'GET').toUpperCase()).toBe(method);
  });
});

describe('эх кодонд бичсэн application.* түлхүүр бүр толь бичигт байна', () => {
  const files = readdirSync(here).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
  it('literal түлхүүр', () => {
    const missing: string[] = [];
    for (const f of files) for (const m of readFileSync(join(here, f), 'utf8').matchAll(/['"`](application\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) if (!hasMessage(m[1] as string)) missing.push(`${f}: ${m[1]}`);
    expect(missing).toEqual([]);
  });
});

// FR-1 "Нэмэх": «Үүсгэх» дээр давхар дарвал (53 мс) хоёр ноорог үүсч байсан — нэг дарах цуврал = нэг хүсэлт.
describe('singleFlight (create modal double-submit guard)', () => {
  const deferred = () => { let resolve!: () => void; let reject!: (e: unknown) => void; const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

  it('a burst of calls while one is in flight runs the task exactly once and shares its promise', async () => {
    const d = deferred();
    const task = vi.fn(() => d.promise);
    const run = singleFlight(task);
    const first = run(); const second = run(); const third = run();
    expect(task).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    d.resolve();
    await first;
  });

  it('after success a new, deliberate submit runs again', async () => {
    const task = vi.fn(() => Promise.resolve());
    const run = singleFlight(task);
    await run();
    await run();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('after a failure the user can retry (guard is released) and the error still reaches the caller', async () => {
    const task = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(undefined);
    const run = singleFlight(task);
    await expect(run()).rejects.toThrow('network');
    await expect(run()).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('a task that throws synchronously also releases the guard', async () => {
    const task = vi.fn().mockImplementationOnce(() => { throw new Error('sync'); }).mockResolvedValueOnce(undefined);
    const run = singleFlight(task);
    await expect(run()).rejects.toThrow('sync');
    await expect(run()).resolves.toBeUndefined();
  });
});

// M1: сервер талын Idempotency-Key. Нэг модал нээлт = нэг түлхүүр (retry-д дахин ашиглана), дараагийн нээлтэд шинэ.
describe('newIdempotencyKey', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('серверийн хэлбэрт (8–128, [A-Za-z0-9_-]) нийцнэ, дуудалт бүр өөр', () => {
    const keys = Array.from({ length: 50 }, () => newIdempotencyKey());
    expect(new Set(keys).size).toBe(50);
    for (const k of keys) expect(k).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });

  it('crypto.randomUUID байвал түүгээр үүсгэнэ', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '11111111-2222-4333-8444-555555555555' });
    expect(newIdempotencyKey()).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('randomUUID байхгүй (http:// — secure бус контекст) үед ч сервер хүлээн авах түлхүүр өгнө', () => {
    vi.stubGlobal('crypto', {});
    const key = newIdempotencyKey();
    expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
    expect(newIdempotencyKey()).not.toBe(key);
  });
});

describe('createIdempotencyKeyHolder (нэг нээлт = нэг түлхүүр)', () => {
  const sequence = () => { let n = 0; return vi.fn(() => `generated-key-${++n}`); };

  it('түлхүүрийг эхний хэрэглээ хүртэл үүсгэхгүй (нээлт бүрт дэмий үүсгэхгүй)', () => {
    const generate = sequence();
    createIdempotencyKeyHolder(generate);
    expect(generate).not.toHaveBeenCalled();
  });

  it('reset хүртэл ижил түлхүүр: retry бүр ижил толгой илгээнэ, үүсгэлт нэг л удаа', () => {
    const generate = sequence();
    const holder = createIdempotencyKeyHolder(generate);
    const first = holder.current();
    expect(holder.current()).toBe(first);
    expect(holder.current()).toBe(first);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('reset (дараагийн нээлт) → шинэ түлхүүр', () => {
    const holder = createIdempotencyKeyHolder(sequence());
    const first = holder.current();
    holder.reset();
    const second = holder.current();
    expect(second).not.toBe(first);
    expect(holder.current()).toBe(second);
  });

  it('reset нь түлхүүр үүсээгүй байхад ч аюулгүй', () => {
    const holder = createIdempotencyKeyHolder(sequence());
    expect(() => { holder.reset(); holder.reset(); }).not.toThrow();
    expect(holder.current()).toBe('generated-key-1');
  });
});

describe('shouldRotateIdempotencyKey', () => {
  it('түлхүүр өөр биетэй ашиглагдсан (422 IDEMPOTENCY_KEY_REUSED) бол солино — хэрэглэгч талбараа засаад дахин оролдож чадна', () => {
    expect(shouldRotateIdempotencyKey(new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'өөр биетэй'))).toBe(true);
  });

  it.each<[string, unknown]>([
    ['сүлжээний алдаа (retry ИЖИЛ түлхүүртэй байх ёстой)', new TypeError('Failed to fetch')],
    ['5xx', new ApiError(503, 'UNAVAILABLE', 'unavailable')],
    ['timeout', new ApiError(504, 'UPSTREAM_TIMEOUT', 'timeout')],
    ['өөр 422', new ApiError(422, 'PRODUCT_NOT_FOUND', 'product')],
    ['код байхгүй алдаа', new ApiError(500, null, 'boom')],
    ['ApiError биш', new Error('x')],
    ['null', null],
  ])('солихгүй: %s', (_name, error) => {
    expect(shouldRotateIdempotencyKey(error)).toBe(false);
  });
});

describe('createApplication → Idempotency-Key толгой', () => {
  let calls: Array<{ url: string; method?: string; headers: Record<string, string>; body?: unknown }>;
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const stubFetch = (next: () => Response) => {
    calls = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      calls.push({ url, method: init?.method, headers, body: init?.body });
      return Promise.resolve(next());
    });
  };
  afterEach(() => vi.unstubAllGlobals());

  it('түлхүүр өгвөл Idempotency-Key толгойд явна, POST /applications, бие JSON', async () => {
    stubFetch(() => respond(201, { id: 'a1' }));
    await api.createApplication({ purpose: 'Орон сууц' }, 'my-key-0001');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API}/origination/applications`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['idempotency-key']).toBe('my-key-0001');
    expect(calls[0].headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].body))).toEqual({ purpose: 'Орон сууц' });
  });

  it('түлхүүргүй бол толгой нэмэхгүй (өмнөх зан төлөв)', async () => {
    stubFetch(() => respond(201, { id: 'a1' }));
    await api.createApplication({});
    expect(calls[0].headers['idempotency-key']).toBeUndefined();
  });

  it('retry: ижил түлхүүрээр хоёр дахь дуудлага ижил толгойтой явна', async () => {
    stubFetch(() => respond(201, { id: 'a1' }));
    const holder = createIdempotencyKeyHolder();
    await api.createApplication({}, holder.current());
    await api.createApplication({}, holder.current());
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual([holder.current(), holder.current()]);
    expect(calls[0].headers['idempotency-key']).toMatch(IDEMPOTENCY_KEY_PATTERN);
  });

  it('201 (шинэ) ба 200 (replay) хоёуланг амжилт гэж үзэж хүсэлтийг буцаана', async () => {
    stubFetch(() => respond(200, { id: 'original' }));
    await expect(api.createApplication({}, 'my-key-0001')).resolves.toMatchObject({ id: 'original' });
    stubFetch(() => respond(201, { id: 'fresh' }));
    await expect(api.createApplication({}, 'my-key-0002')).resolves.toMatchObject({ id: 'fresh' });
  });

  it('422 IDEMPOTENCY_KEY_REUSED нь код, статустай ApiError болж, серверийн монгол мессежээр харагдана', async () => {
    stubFetch(() => respond(422, { code: 'IDEMPOTENCY_KEY_REUSED', message: 'Энэ Idempotency-Key өөр агуулгатай хүсэлтэд ашиглагдсан байна.' }));
    const error = await api.createApplication({}, 'my-key-0001').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(shouldRotateIdempotencyKey(error)).toBe(true);
    expect(describeApplicationError(error, 'application.create.failed')).toContain('Idempotency-Key');
  });

  it('сүлжээний алдаа fetch-ийн анхны TypeError хэвээр (түлхүүрийг солихгүй дахин оролдох боломжтой)', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    const error = await api.createApplication({}, 'my-key-0001').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(shouldRotateIdempotencyKey(error)).toBe(false);
  });
});
