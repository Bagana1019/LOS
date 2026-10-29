import { environmentManager, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API } from '../../lib/api';
import { createEsignQueryClient } from './query';
import { sessionQueryOptions, type WaitingClock } from './session-query';
import { jsonResponse, sessionFixture, signedSession, TOKEN, waitingSession } from './testing/fixtures';

// Polling-ийн бодлогыг TanStack-ийн бодит QueryObserver дээр, хуурамч цаг + хуурамч fetch-ээр шалгана.
const fetchMock = vi.fn();
let client: QueryClient;
let waiting: WaitingClock;
let unsubscribe: (() => void) | undefined;

const urls = (): string[] => fetchMock.mock.calls.map((call) => String(call[0]).replace(`${API}/public/esign/${TOKEN}`, '<session>'));

function observe(): QueryObserver<ReturnType<typeof sessionFixture>, Error> {
  const observer = new QueryObserver<ReturnType<typeof sessionFixture>, Error>(client, sessionQueryOptions(TOKEN, client, waiting));
  unsubscribe = observer.subscribe(() => undefined);
  return observer;
}

// node орчинд (window байхгүй) TanStack өөрийгөө "сервер" гэж үзэж refetchInterval-ийн timer-ийг асаахгүй → клиент гэж заана
beforeAll(() => environmentManager.setIsServer(() => false));
afterAll(() => environmentManager.setIsServer(() => true));

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  client = createEsignQueryClient();
  waiting = { current: null };
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  client.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sessionQueryOptions polling', () => {
  it('PENDING үед polling хийхгүй: ганц GET :token', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(sessionFixture()));
    observe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(urls()).toEqual(['<session>']);
  });

  it('IN_PROGRESS: анхны ачаалал GET :token, дараа нь 2 с тутам GET :token/status', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(waitingSession()));
    observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual(['<session>']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(urls()).toEqual(['<session>', '<session>/status']);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(urls()).toEqual(['<session>', '<session>/status', '<session>/status', '<session>/status']);
  });

  it('60 секундийн дараа 5 секундэд шилжинэ', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(waitingSession()));
    observe();
    await vi.advanceTimersByTimeAsync(60_000);
    const before = fetchMock.mock.calls.length;
    // 60 с хүртэл ~30 хүсэлт (2 с)
    expect(before).toBeGreaterThanOrEqual(30);
    expect(before).toBeLessThanOrEqual(32);
    await vi.advanceTimersByTimeAsync(20_000);
    const slow = fetchMock.mock.calls.length - before;
    expect(slow).toBeGreaterThanOrEqual(4);
    expect(slow).toBeLessThanOrEqual(5);
  });

  it('SIGNED болмогц polling зогсоно', async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse(waitingSession()));
    fetchMock.mockImplementation(async () => jsonResponse(signedSession()));
    const observer = observe();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observer.getCurrentResult().data?.status).toBe('SIGNED');
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(waiting.current).toBeNull();
  });

  it('polling дундаа 404/410 болбол зогсоно', async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse(waitingSession()));
    fetchMock.mockImplementation(async () => jsonResponse({ code: 'NOT_FOUND' }, { status: 410 }));
    const observer = observe();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(observer.getCurrentResult().error).toMatchObject({ kind: 'GONE' });
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('429: Retry-After-аас эрт дахин хүсэхгүй, хуучин өгөгдөл хэвээр үлдэнэ', async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse(waitingSession()));
    fetchMock.mockImplementationOnce(async () => jsonResponse({}, { status: 429, headers: { 'Retry-After': '30' } }));
    fetchMock.mockImplementation(async () => jsonResponse(waitingSession()));
    const observer = observe();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(observer.getCurrentResult().error).toMatchObject({ kind: 'RATE_LIMITED', retryAfterMs: 30_000 });
    expect(observer.getCurrentResult().data?.status).toBe('IN_PROGRESS');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(fetchMock.mock.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('буруу токентой бол огт хүсэлт гаргахгүй', async () => {
    const observer = new QueryObserver(client, sessionQueryOptions('short', client, waiting));
    unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
