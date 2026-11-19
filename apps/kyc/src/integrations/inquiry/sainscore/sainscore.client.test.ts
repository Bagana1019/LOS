import { describe, expect, it } from 'vitest';
import { InquiryRejectedError, InquiryUnavailableError } from '../inquiry.provider';
import { SainScoreClient } from './sainscore.client';

// SainScore (ЗМС) API Inquire v1.7 — Python лавлагаа + fetch stub. Бодит vendor-т хандаагүй (hermetic).
const BASE = 'https://zms.example.test/api';
const PASSWORD_HASH = 'HASH-SECRET-abc';
const REQ = { registerNo: 'УБ99010203', productNo: '13611304', phone: '99112233', email: 'borrower@example.mn' };
const SECRETS = [PASSWORD_HASH, 'TOKEN-1', REQ.registerNo, REQ.phone, REQ.email];

interface Call { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | undefined }
type Handler = (call: Call, n: number) => Response | Promise<Response> | Error;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const loginOk = (token = 'TOKEN-1') => json(200, { success: true, msg: 'ok', user: { id: 1 }, token });
const inquiryOk = (rows: unknown[] = [{ dutytype: 'LN', balance: 1 }]) => json(200, { responsecode: 'SR0000', responsemsg: 'OK', decision: 'APPROVED', inquiry: rows });

function harness(routes: Record<string, Handler | Handler[]>, opts: { nowMs?: () => number; timeoutMs?: number; maxLoginRetries?: number; baseUrl?: string; deadlineMs?: number; minInquiryBudgetMs?: number } = {}) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const sleeps: number[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = { url: String(url), method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = `${call.method} ${call.url.slice(BASE.length)}`;
    const h = routes[key];
    if (!h) return json(404, { error: 'NOT_IN_STUB', key });
    const n = counts.get(key) ?? 0; counts.set(key, n + 1);
    const handler = Array.isArray(h) ? h[Math.min(n, h.length - 1)] : h;
    const r = await handler(call, n);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  const client = new SainScoreClient({ baseUrl: opts.baseUrl ?? BASE, username: 'lender', passwordHash: PASSWORD_HASH, fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, now: opts.nowMs, timeoutMs: opts.timeoutMs, maxLoginRetries: opts.maxLoginRetries, deadlineMs: opts.deadlineMs, minInquiryBudgetMs: opts.minInquiryBudgetMs });
  return { client, calls, sleeps, count: (k: string) => counts.get(k) ?? 0 };
}
const messageOf = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e) { return (e as Error).message; } throw new Error('expected a rejection'); };

describe('SainScoreClient — протокол', () => {
  it('login: POST /login {username, password=vendor hash verbatim}, Authorization-гүй', async () => {
    const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': () => inquiryOk() });
    await h.client.inquiry('CIB', REQ);
    expect(h.calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/login`, body: { username: 'lender', password: PASSWORD_HASH } });
    expect(h.calls[0]!.headers.Authorization).toBeUndefined();
  });

  it('inquiry: POST /inquiry Bearer токен + vendor-ийн яг бие (custregno, custphone, custemail, productno, тогтмол талбарууд)', async () => {
    const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': () => inquiryOk() });
    await h.client.inquiry('CIB', REQ);
    expect(h.calls[1]).toMatchObject({ method: 'POST', url: `${BASE}/inquiry` });
    expect(h.calls[1]!.headers.Authorization).toBe('Bearer TOKEN-1');
    expect(h.calls[1]!.body).toEqual({
      productno: '13611304', purptypeid: '01', purposedesc: 'Зээл лавлагаа авах', acnttypeid: '02',
      custregno: REQ.registerNo, custtypeid: '01', custphone: REQ.phone, custemail: REQ.email,
    });
  });

  it('амжилт (SR0000): decision, responsemsg, мөрүүдийг буцаана', async () => {
    const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': () => inquiryOk([{ dutytype: 'LN' }, { dutytype: 'LS' }]) });
    expect(await h.client.inquiry('CIB', REQ)).toEqual({ decision: 'APPROVED', responseMessage: 'OK', rows: [{ dutytype: 'LN' }, { dutytype: 'LS' }] });
  });

  it('base URL-ийн төгсгөлийн / тэмдэгтийг хасна', async () => {
    const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': () => inquiryOk() }, { baseUrl: `${BASE}///` });
    await h.client.inquiry('CIB', REQ);
    expect(h.calls.map((x) => x.url)).toEqual([`${BASE}/login`, `${BASE}/inquiry`]);
  });
});

describe('SainScoreClient — токен', () => {
  it('токеныг cache хийнэ: дараалсан inquiry-д нэг л login', async () => {
    const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': () => inquiryOk() });
    await h.client.inquiry('CIB', REQ);
    await h.client.inquiry('CIB', REQ);
    expect(h.count('POST /login')).toBe(1);
    expect(h.count('POST /inquiry')).toBe(2);
  });

  it('зэрэг inquiry нэг login-ийг хуваалцана (single-flight)', async () => {
    const h = harness({ 'POST /login': async () => { await new Promise((r) => setTimeout(r, 15)); return loginOk(); }, 'POST /inquiry': () => inquiryOk() });
    await Promise.all([h.client.inquiry('CIB', REQ), h.client.inquiry('CIB', REQ), h.client.inquiry('CIB', REQ)]);
    expect(h.count('POST /login')).toBe(1);
  });

  it('vendor-ийн 1000 минутын токен: 990 минутын дараа дахин login (аюулгүй зай)', async () => {
    let t = 1_000_000;
    const h = harness({ 'POST /login': [() => loginOk('T1'), () => loginOk('T2')], 'POST /inquiry': () => inquiryOk() }, { nowMs: () => t });
    await h.client.inquiry('CIB', REQ);
    t += 989 * 60_000;
    await h.client.inquiry('CIB', REQ);
    expect(h.count('POST /login')).toBe(1);
    t += 2 * 60_000;
    await h.client.inquiry('CIB', REQ);
    expect(h.count('POST /login')).toBe(2);
    expect(h.calls.at(-1)!.headers.Authorization).toBe('Bearer T2');
  });

  it('inquiry дээр 401: токеныг хаяна, дахин илгээхгүй (Unavailable); дараагийн дуудлага шинэ login хийнэ', async () => {
    const h = harness({ 'POST /login': [() => loginOk('T1'), () => loginOk('T2')], 'POST /inquiry': [() => json(401, {}), () => inquiryOk()] });
    await expect(h.client.inquiry('CIB', REQ)).rejects.toBeInstanceOf(InquiryUnavailableError);
    expect(h.count('POST /inquiry')).toBe(1);
    await h.client.inquiry('CIB', REQ);
    expect(h.count('POST /login')).toBe(2);
    expect(h.calls.at(-1)!.headers.Authorization).toBe('Bearer T2');
  });

  it('login success:false → InquiryRejectedError(LOGIN_REJECTED), дахин оролдохгүй', async () => {
    const h = harness({ 'POST /login': () => json(200, { success: false, msg: 'Нэр эсвэл нууц үг буруу' }) });
    const err = await h.client.inquiry('CIB', REQ).catch((e) => e);
    expect(err).toBeInstanceOf(InquiryRejectedError);
    expect(err.vendorCode).toBe('LOGIN_REJECTED');
    expect(h.count('POST /login')).toBe(1);
  });

  it('login хариунд token байхгүй → InquiryUnavailableError', async () => {
    const h = harness({ 'POST /login': () => json(200, { success: true, msg: 'ok' }) }, { maxLoginRetries: 0 });
    await expect(h.client.inquiry('CIB', REQ)).rejects.toBeInstanceOf(InquiryUnavailableError);
  });

  it('login 5xx-ийг exponential backoff-оор 2 удаа дахин оролдоно (idempotent), inquiry нэг л удаа явна', async () => {
    const h = harness({ 'POST /login': [() => json(503, {}), () => json(500, {}), () => loginOk()], 'POST /inquiry': () => inquiryOk() });
    await h.client.inquiry('CIB', REQ);
    expect(h.count('POST /login')).toBe(3);
    expect(h.count('POST /inquiry')).toBe(1);
    expect(h.sleeps).toEqual([300, 600]);
  });

  it('login 3 удаа 5xx бол InquiryUnavailableError, inquiry огт явахгүй', async () => {
    const h = harness({ 'POST /login': () => json(502, {}), 'POST /inquiry': () => inquiryOk() });
    await expect(h.client.inquiry('CIB', REQ)).rejects.toBeInstanceOf(InquiryUnavailableError);
    expect(h.count('POST /login')).toBe(3);
    expect(h.count('POST /inquiry')).toBe(0);
  });
});

describe('SainScoreClient — төлбөртэй /inquiry-г хэзээ ч дахин илгээхгүй', () => {
  it('HTTP 5xx → Unavailable, 1 дуудлага, sleep үгүй', async () => {
    const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': [() => json(503, {}), () => inquiryOk()] });
    await expect(h.client.inquiry('CIB', REQ)).rejects.toBeInstanceOf(InquiryUnavailableError);
    expect(h.count('POST /inquiry')).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it('сүлжээний алдаа → Unavailable, 1 дуудлага', async () => {
    const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': [() => new TypeError('fetch failed'), () => inquiryOk()] });
    await expect(h.client.inquiry('CIB', REQ)).rejects.toBeInstanceOf(InquiryUnavailableError);
    expect(h.count('POST /inquiry')).toBe(1);
  });

  it('timeout: AbortController-оор таслаад Unavailable, дахин илгээхгүй', async () => {
    let inquiryCalls = 0;
    const fetchImpl = ((url: string, init?: RequestInit) => {
      if (url.endsWith('/login')) return Promise.resolve(loginOk());
      inquiryCalls++;
      return new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }) as unknown as typeof fetch;
    const client = new SainScoreClient({ baseUrl: BASE, username: 'u', passwordHash: 'h', fetchImpl, sleep: async () => undefined, timeoutMs: 20 });
    const err = await client.inquiry('CIB', REQ).catch((e) => e);
    expect(err).toBeInstanceOf(InquiryUnavailableError);
    expect(inquiryCalls).toBe(1);
  });

  it('JSON биш / объект биш хариу → Unavailable', async () => {
    for (const bad of [new Response('<html>', { status: 200 }), json(200, [1, 2]), json(200, null)]) {
      const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': () => bad });
      await expect(h.client.inquiry('CIB', REQ)).rejects.toBeInstanceOf(InquiryUnavailableError);
    }
  });

  it('`inquiry` жагсаалт байхгүй / массив биш → Unavailable (төлөгдөөгүй гэж таамаглахгүй)', async () => {
    for (const body of [{ responsecode: 'SR0000' }, { responsecode: 'SR0000', inquiry: 'x' }, { responsecode: 'SR0000', inquiry: null }]) {
      const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': () => json(200, body) });
      await expect(h.client.inquiry('CIB', REQ)).rejects.toBeInstanceOf(InquiryUnavailableError);
    }
  });
});

describe('SainScoreClient — vendor responsecode', () => {
  it.each(['SR0050', 'SR1090', 'SR1095'])('%s (vendor-ийн өөрийн сервер алдаа, лавлагаа ажиллаагүй) → Unavailable, дахин илгээхгүй', async (code) => {
    const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': () => json(200, { responsecode: code, responsemsg: 'Баазтай ажиллахад алдаа' }) });
    await expect(h.client.inquiry('CIB', REQ)).rejects.toBeInstanceOf(InquiryUnavailableError);
    expect(h.count('POST /inquiry')).toBe(1);
  });

  it.each([['SR0260', 'Имэйл буруу'], ['SR0270', 'Утас байхгүй'], ['SR0130', 'Хураамжийн гүйлгээний алдаа']])('%s бизнесийн татгалзал → InquiryRejectedError(vendorCode, msg), дахин илгээхгүй', async (code, msg) => {
    const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': () => json(200, { responsecode: code, responsemsg: msg }) });
    const err = await h.client.inquiry('CIB', REQ).catch((e) => e);
    expect(err).toBeInstanceOf(InquiryRejectedError);
    expect(err).toMatchObject({ source: 'CIB', vendorCode: code });
    expect(err.message).toContain(code);
    expect(h.count('POST /inquiry')).toBe(1);
  });

  // Review M1: responsecode байхгүй = амжилт БИШ (gateway/алдааны JSON хоосон зээлийн түүх гэж буруу ойлгогдож чадавхийг хэтрүүлэхээс сэргийлнэ).
  it.each([[{ inquiry: [] }], [{ responsecode: null, inquiry: [] }]])('responsecode байхгүй / null %j → Unavailable (хоосон түүх гэж таамаглахгүй)', async (body) => {
    const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': () => json(200, body) });
    await expect(h.client.inquiry('CIB', REQ)).rejects.toBeInstanceOf(InquiryUnavailableError);
  });

  it('vendor-ийн мессежийг 200 тэмдэгтэд тайрна', async () => {
    const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': () => json(200, { responsecode: 'SR0999', responsemsg: 'x'.repeat(500) }) });
    const err = await h.client.inquiry('CIB', REQ).catch((e) => e);
    expect(err.message.length).toBeLessThan(260);
  });
});

// Review H3: origination kyc-г 15с-д хүлээдэг. kyc-ийн нийт хугацаа (login + хураамжтай /inquiry) түүнээс богино байх ёстой, эс бөгөөс origination timeout-д орж
// хэрэглэгч дахин дарахад kyc-д аль хэдийн төлөгдсөн лавлагаа ДАХИН төлөгдөнө.
describe('SainScoreClient — нийт хугацааны төсөв (deadline)', () => {
  const slowLogin = (ms: number): Handler => async () => { await new Promise((r) => setTimeout(r, ms)); return loginOk(); };

  it('login төсвийг барсан бол хураамжтай /inquiry-г ЯВУУЛАХГҮЙ (төлбөргүй түр алдаа)', async () => {
    const h = harness({ 'POST /login': slowLogin(300), 'POST /inquiry': () => inquiryOk() }, { deadlineMs: 1000, minInquiryBudgetMs: 2000 });
    await expect(h.client.inquiry('CIB', REQ)).rejects.toBeInstanceOf(InquiryUnavailableError);
    expect(h.count('POST /inquiry')).toBe(0);
  });

  it('төсөв хангалттай бол /inquiry явна', async () => {
    const h = harness({ 'POST /login': slowLogin(50), 'POST /inquiry': () => inquiryOk() }, { deadlineMs: 5000, minInquiryBudgetMs: 2000 });
    await h.client.inquiry('CIB', REQ);
    expect(h.count('POST /inquiry')).toBe(1);
  });

  it('/inquiry удаавал нийт хугацаа deadline-аас хэтрэхгүй (timeout-ийг үлдсэн төсвөөр хязгаарлана), дахин илгээхгүй', async () => {
    // AbortSignal-ийг хүндэтгэдэг fetch (harness-ийнх хүндэтгэдэггүй): /inquiry 3с удаан хариулна.
    let inquiryCalls = 0;
    const fetchImpl = ((url: string, init?: RequestInit) => {
      if (url.endsWith('/login')) return Promise.resolve(loginOk());
      inquiryCalls++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(inquiryOk()), 3000);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      });
    }) as unknown as typeof fetch;
    const client = new SainScoreClient({ baseUrl: BASE, username: 'u', passwordHash: 'h', fetchImpl, sleep: async () => undefined, timeoutMs: 20_000, deadlineMs: 700, minInquiryBudgetMs: 100 });
    const started = Date.now();
    await expect(client.inquiry('CIB', REQ)).rejects.toBeInstanceOf(InquiryUnavailableError);
    expect(Date.now() - started).toBeLessThan(1800); // timeoutMs=20с байсан ч нийт төсвөөр (0.7с) таслагдана
    expect(inquiryCalls).toBe(1);
  });

  it('токен cache-тэй үед login-д төсөв зарцуулахгүй', async () => {
    const h = harness({ 'POST /login': () => loginOk(), 'POST /inquiry': () => inquiryOk() }, { deadlineMs: 2500, minInquiryBudgetMs: 2000 });
    await h.client.inquiry('CIB', REQ);
    await h.client.inquiry('CIB', REQ);
    expect(h.count('POST /inquiry')).toBe(2);
  });
});

describe('SainScoreClient — нууц / хувийн мэдээлэл алдаанд гарахгүй', () => {
  it.each([
    ['5xx', { 'POST /inquiry': () => json(500, { echo: REQ.registerNo }) }],
    ['бизнесийн татгалзал', { 'POST /inquiry': () => json(200, { responsecode: 'SR0260', responsemsg: 'Имэйл буруу' }) }],
    ['сүлжээ', { 'POST /inquiry': () => new TypeError(`fetch failed ${REQ.phone}`) }],
  ])('%s: алдааны мессеж регистр, утас, имэйл, токен, нууц hash агуулахгүй', async (_l, routes) => {
    const h = harness({ 'POST /login': () => loginOk(), ...routes } as Record<string, Handler>);
    const msg = await messageOf(h.client.inquiry('CIB', REQ));
    for (const secret of SECRETS) expect(msg).not.toContain(secret);
  });
});
