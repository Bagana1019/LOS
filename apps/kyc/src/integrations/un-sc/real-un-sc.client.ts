// RealUnScClient: НҮБ-ын нэгдсэн жагсаалтыг (нийтийн XML) татаж UnSanctionsSnapshot болгоно. Нууц байхгүй; харин татах зам нь аюулгүй байх ёстой:
//  - scsanctions.un.org → 302 → Azure Blob-ийн богино настай SAS холбоос. Redirect-ийг БИД ГАРААР дагана (redirect:'manual'): алхам бүр https, хостын allow-list, ≤3 алхам.
//  - Алдааны мессеж URL (sig), зам, бичлэгийн агуулгыг оруулахгүй. Хоосон / буруу хариуг snapshot болгон буцаахгүй (WatchlistService 503 / cache-ээр хариулна).
//  - Хугацаа: өөрийн 15с + WatchlistService-ийн signal; хэмжээ: ≤32 MiB.
import { ExternalListError } from '../errors';
import { parseUnConsolidatedXml } from './un-consolidated.parser';
import type { UnScClient, UnSanctionsSnapshot } from './un-sc.client';
import { loadUnScConfig, UN_SC_DEFAULT_TIMEOUT_MS, UN_SC_MAX_BYTES, UN_SC_MAX_REDIRECTS, UN_SC_STORAGE_HOST, type UnScConfig } from './un-sc.config';

type Env = Record<string, string | undefined>;

export interface RealUnScOptions {
  env?: Env;
  /** Тестэд сүлжээгүйгээр орлуулна. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

const fail = (reason: string): never => { throw new ExternalListError('un-sc', reason); };
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Биеийг уншилгүй цуцална (холболтыг чөлөөлнө). */
const discard = (res: Response): void => { void res.body?.cancel().catch(() => undefined); };

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { discard(res); return fail('response is too large'); }
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => undefined); return fail('response is too large'); }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

export class RealUnScClient implements UnScClient {
  constructor(private readonly options: RealUnScOptions = {}) {}

  async fetchSnapshot(signal?: AbortSignal): Promise<UnSanctionsSnapshot> {
    const cfg = loadUnScConfig(this.options.env ?? process.env); // буруу тохиргоо → татахаас өмнө унана (fail closed)
    return parseUnConsolidatedXml(await this.download(cfg, signal));
  }

  private async download(cfg: UnScConfig, external?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? UN_SC_DEFAULT_TIMEOUT_MS);
    const signal = external ? AbortSignal.any([external, timeout]) : timeout;
    try {
      return await this.follow(cfg, signal);
    } catch (e) {
      if (e instanceof ExternalListError) throw e;
      if (timeout.aborted) return fail('download timed out');
      if (external?.aborted) return fail('download aborted');
      const code = (e as { cause?: { code?: unknown } }).cause?.code;
      return fail(typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? `network error (${code})` : 'network error');
    }
  }

  private async follow(cfg: UnScConfig, signal: AbortSignal): Promise<string> {
    const doFetch = this.options.fetch ?? fetch;
    const allowed = new Set([new URL(cfg.url).hostname.toLowerCase(), UN_SC_STORAGE_HOST, ...cfg.extraRedirectHosts]);
    let url = new URL(cfg.url);
    for (let redirects = 0; ; redirects += 1) {
      const res = await doFetch(url.toString(), { method: 'GET', redirect: 'manual', headers: { accept: 'application/xml, text/xml' }, signal });
      if (!REDIRECT_STATUSES.has(res.status)) {
        if (!res.ok) { discard(res); return fail(`HTTP ${res.status}`); }
        return readCapped(res, this.options.maxBytes ?? UN_SC_MAX_BYTES);
      }
      discard(res);
      if (redirects >= UN_SC_MAX_REDIRECTS) return fail('too many redirects');
      url = this.nextHop(res.headers.get('location'), url, allowed);
    }
  }

  /** Redirect-ийн зорилтыг шалгана: https, нэвтрэх мэдээллүүгүй, allow-list-д байгаа хост. Алдаа нь зөвхөн хостыг заана (query/sig-гүй). */
  private nextHop(location: string | null, current: URL, allowed: Set<string>): URL {
    if (!location) return fail('redirect without a Location header');
    let next: URL;
    try { next = new URL(location, current); } catch { return fail('redirect target is not a valid URL'); }
    if (next.protocol !== 'https:') return fail('redirect target must use https');
    if (next.username || next.password) return fail('redirect target must not carry credentials');
    if (!allowed.has(next.hostname.toLowerCase())) {
      return fail(`redirect to host "${next.hostname}" is not allowed (add it to UN_SC_REDIRECT_HOSTS only if it is a legitimate UN mirror)`);
    }
    return next;
  }
}
