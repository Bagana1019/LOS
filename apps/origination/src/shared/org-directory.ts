import { Inject, Injectable, Logger } from '@nestjs/common';
import { DIRECTORY_TOKEN_HEADER, OrgDirectory, type RequestContext } from '@los/contracts';
import { Clock, InternalHttpClient } from '@los/nest-common';

/**
 * Excel/CSV экспортын нэр: салбар, ЗЭЗ-ийн id → харуулах нэр. Нэр нь gateway-ийн `iam` schema-д тул origination өөр schema УНШИХГҮЙ
 * (CLAUDE.md §3.2.3) — gateway-ийн дотоод лавлахаас (`GET /api/internal/directory`) org тутамд нэг удаа авч TTL-тэй кэшлэнэ.
 * Хүсэлтийн урсгалд биш, зөвхөн экспорт бичих үед: лавлах унасан/буруу бол экспорт ҮРГЭЛЖ амжилттай, id хэвээр (warning лог).
 */
export const ORG_DIRECTORY_SOURCE = Symbol('ORG_DIRECTORY_SOURCE');
/** CLAUDE.md §3.2.8: дотоод лавлах/тохиргооны кэш 60с. */
export const ORG_DIRECTORY_TTL_MS = 60_000;
/** CLAUDE.md §3.1: дотоод sync дуудлагын timeout 3с. */
export const ORG_DIRECTORY_TIMEOUT_MS = 3_000;
const EMPTY: OrgDirectory = Object.freeze({ branches: Object.freeze({}), users: Object.freeze({}) }) as OrgDirectory;

export interface OrgDirectorySource { fetch(ctx: RequestContext): Promise<OrgDirectory> }

/** Нэр олдвол нэр, үгүй бол id. `Object.prototype`-ийн түлхүүр (constructor, __proto__) нэр болохгүй. */
export const directoryName = (names: Readonly<Record<string, string>>, id: string): string => (Object.hasOwn(names, id) ? (names[id] as string) : id);

export interface HttpOrgDirectoryOptions { env?: NodeJS.ProcessEnv; fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void> }

/**
 * origination → gateway (унших-зөвхөн). `GATEWAY_URL` (анхдагч http://localhost:4000). Хариуг `OrgDirectory` (strict) схемээр шалгана.
 * Нэвтрэлт: ЗӨВХӨН өөрийн `GATEWAY_DIRECTORY_TOKEN` (`X-Directory-Token`). `INTERNAL_AUTH_SECRET`-ийг энд илгээхгүй — gateway ч энэ замд хүлээн авдаггүй
 * (proxy бүх backend-д тарааж өгдөг нууц). Токен тохируулаагүй бол сүлжээнд хандахгүйгээр алдаа → `OrgDirectoryService` id-д буцна.
 * Redirect дагахгүй: токен өөр хост руу алдагдахаас сэргийлнэ.
 */
export class HttpOrgDirectorySource implements OrgDirectorySource {
  private readonly env: NodeJS.ProcessEnv;
  private readonly http: InternalHttpClient;

  constructor(opts: HttpOrgDirectoryOptions = {}) {
    this.env = opts.env ?? process.env;
    const base = opts.fetchFn ?? fetch;
    const withDirectoryToken: typeof fetch = (input, init) => {
      const headers = { ...(init?.headers as Record<string, string> | undefined), [DIRECTORY_TOKEN_HEADER]: this.token() ?? '' };
      return base(input, { ...init, headers, redirect: 'error' });
    };
    // INTERNAL_AUTH_SECRET-гүй env: InternalHttpClient `X-Internal-Token` нэмэхгүй
    this.http = new InternalHttpClient({ env: { ...this.env, INTERNAL_AUTH_SECRET: undefined }, fetchFn: withDirectoryToken, sleep: opts.sleep });
  }

  private token(): string | null { return this.env.GATEWAY_DIRECTORY_TOKEN?.trim() || null; }

  fetch(ctx: RequestContext): Promise<OrgDirectory> {
    if (!this.token()) return Promise.reject(new Error('GATEWAY_DIRECTORY_TOKEN is not configured'));
    return this.http.get('gateway', '/api/internal/directory', { ctx, timeoutMs: ORG_DIRECTORY_TIMEOUT_MS, schema: OrgDirectory });
  }
}

export const createOrgDirectorySource = (env: NodeJS.ProcessEnv = process.env): HttpOrgDirectorySource => new HttpOrgDirectorySource({ env });

@Injectable()
export class OrgDirectoryService {
  private readonly logger = new Logger(OrgDirectoryService.name);
  private readonly cache = new Map<string, { at: number; value: OrgDirectory }>();
  private readonly inflight = new Map<string, Promise<OrgDirectory>>();

  constructor(@Inject(ORG_DIRECTORY_SOURCE) private readonly source: OrgDirectorySource, private readonly clock: Clock) {}

  /** Хэзээ ч reject хийхгүй: алдаа → хоосон лавлах (id хэвээр үлдэнэ) + warning. Алдааг кэшлэхгүй (дараагийн экспорт дахин оролдоно). */
  load(ctx: RequestContext): Promise<OrgDirectory> {
    const now = this.clock.now().getTime();
    const hit = this.cache.get(ctx.orgId);
    if (hit && now - hit.at < ORG_DIRECTORY_TTL_MS) return Promise.resolve(hit.value);
    return this.inflight.get(ctx.orgId) ?? this.fetchFresh(ctx, now);
  }

  private fetchFresh(ctx: RequestContext, now: number): Promise<OrgDirectory> {
    const run = this.source.fetch(ctx).then(
      (value) => { this.cache.set(ctx.orgId, { at: now, value }); return value; },
      (e: unknown) => {
        // Зөвхөн алдааны мессеж: upstream body (ажилтны нэр) логт орохгүй
        this.logger.warn(`org directory unavailable, export falls back to ids [correlationId=${ctx.correlationId}]: ${e instanceof Error ? e.message : String(e)}`);
        return EMPTY;
      },
    ).finally(() => { this.inflight.delete(ctx.orgId); });
    this.inflight.set(ctx.orgId, run);
    return run;
  }
}
