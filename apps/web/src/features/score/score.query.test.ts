import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScorePreviewResponse, ScoreTerms } from '@los/contracts';
import { overviewKey, previewKey, previewQueryOptions, previewRootKey, retryTransient, type PreviewFetcher } from './score.query';
import { APP_ID, TERMS, previewResponse } from './testing/fixtures';

// FR-8.3: slider → preview. "Latest wins" — өмнөх утгын хоцорсон хариу шинэ утгын үр дүнг дарахгүй, өмнөх хүсэлт цуцлагдана.

interface Deferred {
  resolve: (v: ScorePreviewResponse) => void;
  reject: (e: unknown) => void;
  promise: Promise<ScorePreviewResponse>;
}
const deferred = (): Deferred => {
  let resolve!: Deferred['resolve'];
  let reject!: Deferred['reject'];
  const promise = new Promise<ScorePreviewResponse>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
};

const at = (termMonths: number): ScoreTerms => ({ ...TERMS, termMonths });
const clients: QueryClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.clear();
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const requests = new Map<number, { d: Deferred; signal: AbortSignal }>();
  const fetcher: PreviewFetcher = (_id, body, signal) => {
    const d = deferred();
    requests.set(body.termMonths!, { d, signal: signal! });
    return d.promise;
  };
  const observer = new QueryObserver(client, previewQueryOptions(APP_ID, at(12), true, fetcher));
  const unsubscribe = observer.subscribe(() => undefined);
  const use = (terms: ScoreTerms | null, enabled = true) => observer.setOptions(previewQueryOptions(APP_ID, terms, enabled, fetcher));
  return { client, observer, requests, use, unsubscribe };
}

describe('preview query: latest wins', () => {
  it('хоцорсон хариу шинэ утгын үр дүнг дарахгүй, өмнөх хүсэлтийн signal цуцлагдана', async () => {
    const { observer, requests, use, unsubscribe } = setup();
    await vi.waitFor(() => expect(requests.has(12)).toBe(true));
    use(at(36));
    await vi.waitFor(() => expect(requests.has(36)).toBe(true));
    expect(requests.get(12)!.signal.aborted).toBe(true); // өмнөх хүсэлт цуцлагдсан

    requests.get(36)!.d.resolve(previewResponse(at(36)));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.terms.termMonths).toBe(36));

    requests.get(12)!.d.resolve(previewResponse(at(12))); // хоцорсон хариу
    await new Promise((r) => setTimeout(r, 20));
    expect(observer.getCurrentResult().data?.terms.termMonths).toBe(36);
    unsubscribe();
  });

  it('шинэ хариу ирэх хүртэл өмнөх үр дүн (placeholder) харагдана, дараа нь солигдоно', async () => {
    const { observer, requests, use, unsubscribe } = setup();
    await vi.waitFor(() => expect(requests.has(12)).toBe(true));
    requests.get(12)!.d.resolve(previewResponse(at(12)));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.terms.termMonths).toBe(12));

    use(at(24));
    await vi.waitFor(() => expect(requests.has(24)).toBe(true));
    const loading = observer.getCurrentResult();
    expect(loading.isPlaceholderData).toBe(true);
    expect(loading.data?.terms.termMonths).toBe(12);
    expect(loading.isFetching).toBe(true);

    requests.get(24)!.d.resolve(previewResponse(at(24)));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.terms.termMonths).toBe(24));
    expect(observer.getCurrentResult().isPlaceholderData).toBe(false);
    unsubscribe();
  });

  it('алдаа: шинэ утгын алдаа гарна, өмнөх утгын алдаа дамжихгүй', async () => {
    const { observer, requests, use, unsubscribe } = setup();
    await vi.waitFor(() => expect(requests.has(12)).toBe(true));
    requests.get(12)!.d.reject(Object.assign(new Error('x'), { status: 422, code: 'OUT_OF_PRODUCT_LIMITS' }));
    await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));

    use(at(18));
    await vi.waitFor(() => expect(requests.has(18)).toBe(true));
    expect(observer.getCurrentResult().isError).toBe(false);
    requests.get(18)!.d.resolve(previewResponse(at(18)));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.terms.termMonths).toBe(18));
    unsubscribe();
  });

  it('terms=null эсвэл enabled=false үед хүсэлт явуулахгүй', async () => {
    const client = new QueryClient();
    clients.push(client);
    const fetcher = vi.fn<PreviewFetcher>();
    const a = new QueryObserver(client, previewQueryOptions(APP_ID, null, true, fetcher));
    const b = new QueryObserver(client, previewQueryOptions(APP_ID, TERMS, false, fetcher));
    const offs = [a.subscribe(() => undefined), b.subscribe(() => undefined)];
    await new Promise((r) => setTimeout(r, 20));
    expect(fetcher).not.toHaveBeenCalled();
    offs.forEach((off) => off());
  });

  it('preview-г кэшлэхгүй (staleTime 0): ижил утгыг дахин идэвхжүүлбэл дахин асууна', () => {
    const o = previewQueryOptions(APP_ID, TERMS, true);
    expect(o.staleTime).toBe(0);
    expect(o.gcTime).toBeLessThanOrEqual(60_000);
  });
});

describe('түлхүүр, retry', () => {
  it('түлхүүр утгаар тогтвортой; бүх preview-г нэг root-оор цэвэрлэнэ', () => {
    expect(previewKey('a', TERMS)).toEqual(['score', 'a', 'preview', '20000000|24|23.99']);
    expect(previewKey('a', TERMS)).toEqual(previewKey('a', { ...TERMS }));
    expect(previewKey('a', at(12))).not.toEqual(previewKey('a', at(13)));
    expect(previewKey('a', TERMS).slice(0, 3)).toEqual([...previewRootKey('a')]);
    expect(overviewKey('a')).toEqual(['score', 'a', 'overview']);
  });

  it('retryTransient: 4xx-г дахин оролдохгүй, сүлжээ/5xx-г нэг удаа', () => {
    expect(retryTransient(0, { status: 422 })).toBe(false);
    expect(retryTransient(0, { status: 409 })).toBe(false);
    expect(retryTransient(0, { status: 503 })).toBe(true);
    expect(retryTransient(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(retryTransient(1, { status: 503 })).toBe(false);
    expect(retryTransient(0, null)).toBe(true);
  });
});
