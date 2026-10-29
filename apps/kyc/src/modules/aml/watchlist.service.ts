// Хориг/эрсдэлийн жагсаалтын (UN_SC, FATF) cache — автомат шалгалтын эх үүсвэр (FR-3.4).
// FAIL CLOSED: жагсаалтыг татаж чадахгүй, ашиглах боломжтой cache байхгүй бол хэзээ ч хоосон ("цэвэр") үр дүн буцаахгүй,
// WatchlistUnavailableError шидэнэ. Хугацаа зөвхөн тарьсан Clock-оор (тест deterministic).
import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { DEFAULT_AML_POLICY, type AmlListStatus, type ScreeningList } from '@los/contracts';
import { FATF_CLIENT, type FatfClient, type FatfSnapshot } from '../../integrations/fatf/fatf.client';
import { UN_SC_CLIENT, type UnScClient, type UnSanctionsSnapshot } from '../../integrations/un-sc/un-sc.client';
import { AML_CLOCK, type Clock } from './aml.ports';

export const WATCHLIST_OPTIONS = Symbol('WATCHLIST_OPTIONS');
export interface WatchlistOptions {
  refreshIntervalMinutes?: number;
  /** Гадаад жагсаалт татах дээд хугацаа (мс). CLAUDE.md §3.1: гадаад дуудлага 15с. */
  fetchTimeoutMs?: number;
  /**
   * Татаж чадаагүй / хугацаа хэтэрсэн таталтын дараа энэ хугацаанд (мс) шинэ таталт ЭХЛҮҮЛЭХГҮЙ: ашиглах боломжтой хуучин cache-ийг даруй
   * (degraded) өгнө, байхгүй бол сануулсан алдаагаар даруй 503. Анхдагч 30000. 0 → хаалтгүй. Админы албадан refresh() хамаарахгүй.
   */
  retryBackoffMs?: number;
  /**
   * Өмнө хүлээн авсан snapshot >= 20 бичилттэй байхад шинэ snapshot-ийн бичилтийн тоо өмнөхийнхөө энэ хэсгээс БАГА бол таталт амжилтгүй
   * (хэсэгчилсэн / тасарсан таталт) гэж үзнэ. Анхдагч 0.5. 0 → шалгахгүй.
   */
  minSnapshotRatio?: number;
}

/** Snapshot татаж чадахгүй хуучин cache-ээр шалгасан бол listVersions-д энэ дагавар нэмэгдэнэ; шинэ snapshot ирэхэд rescreen хийгдэнэ. */
export const STALE_SUFFIX = '+stale';

export type WatchedList = Extract<ScreeningList, 'UN_SC' | 'FATF'>;

export interface LoadedSnapshot<T> { snapshot: T; fetchedAt: Date; degraded: boolean }

/** Жагсаалтыг татаж чадаагүй бөгөөд хэрэглэж болох cache байхгүй (503). */
export class WatchlistUnavailableError extends ServiceUnavailableException {
  constructor(readonly list: WatchedList, reason: string, cause?: unknown) {
    super(`Sanctions list ${list} is unavailable: ${reason}`, { cause });
  }
}

const DEFAULT_REFRESH_MINUTES = 360;
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_RETRY_BACKOFF_MS = 30_000;
export const DEFAULT_MIN_SNAPSHOT_RATIO = 0.5;
/** Хэсэгчилсэн таталтын хамгаалалт зөвхөн өмнөх snapshot энэ тооноос олон бичилттэй үед ажиллана (жижиг жагсаалт хууль ёсоор багасаж болно). */
export const TRUNCATION_GUARD_MIN_ENTRIES = 20;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const log = new Logger('WatchlistService');

function resolveRefreshMinutes(options: WatchlistOptions | undefined): number {
  const raw = options?.refreshIntervalMinutes ?? (process.env.AML_LIST_REFRESH_MINUTES || DEFAULT_REFRESH_MINUTES);
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`Invalid AML list refresh interval "${raw}": expected a positive number of minutes`);
  return minutes;
}

function resolveFetchTimeoutMs(options: WatchlistOptions | undefined): number {
  const ms = options?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`Invalid AML list fetch timeout "${ms}": expected a positive number of milliseconds`);
  return ms;
}

function resolveRetryBackoffMs(options: WatchlistOptions | undefined): number {
  const ms = options?.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid AML list retry backoff "${ms}": expected a non-negative number of milliseconds`);
  return ms;
}

function resolveMinSnapshotRatio(options: WatchlistOptions | undefined): number {
  const ratio = options?.minSnapshotRatio ?? DEFAULT_MIN_SNAPSHOT_RATIO;
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error(`Invalid AML list minimum snapshot ratio "${ratio}": expected a number between 0 and 1`);
  return ratio;
}

/** Screening-д хадгалах хувилбар: хуучин cache-ээр шалгасан бол дагавартай. screen() болон currentVersions() ижил дүрэм ашиглана. */
export function stampedVersion(loaded: { snapshot: { version: string }; degraded: boolean }): string {
  return loaded.snapshot.version + (loaded.degraded ? STALE_SUFFIX : '');
}

interface ListSnapshot { version: string; publishedAt: string; entries: readonly unknown[] }
interface Cached<T> { snapshot: T; fetchedAt: Date }

interface CachedListConfig { refreshMs: number; fetchTimeoutMs: number; retryBackoffMs: number; minSnapshotRatio: number }

/** Нэг жагсаалтын cache: single-flight ачаалалт, сүүлийн алдаа, алдааны дараах хаалт (backoff). */
class CachedList<T extends ListSnapshot> {
  private cached: Cached<T> | null = null;
  private lastError: string | null = null;
  /** Сүүлийн амжилтгүй таталтын шалтгаан: backoff-ийн хугацаанд шинэ таталтгүйгээр дахин өгнө. */
  private lastFailure: unknown = null;
  /** Сүүлийн амжилтгүй таталт дууссан цаг (Clock). null → сүүлийн таталт амжилттай / хараахан оролдоогүй. */
  private lastAttemptAt: Date | null = null;
  private inflight: Promise<Cached<T>> | null = null;

  constructor(
    private readonly list: WatchedList,
    private readonly client: { fetchSnapshot(signal?: AbortSignal): Promise<T> },
    private readonly clock: Clock,
    private readonly config: CachedListConfig,
  ) {}

  async get(maxStaleHours: number): Promise<LoadedSnapshot<T>> {
    const hit = this.cached;
    if (hit && this.lastError === null && this.ageMs(hit) < this.config.refreshMs) return this.loaded(hit, false);
    try {
      return this.loaded(await this.reloadUnlessBackingOff(), false);
    } catch (cause) {
      const old = this.cached;
      if (old && this.ageMs(old) <= maxStaleHours * HOUR_MS) return this.loaded(old, true);
      throw new WatchlistUnavailableError(this.list, old ? `cached snapshot is older than ${maxStaleHours}h` : 'no cached snapshot', cause);
    }
  }

  /** Нэгэн зэрэг дуудсан бүгд нэг ачаалалтыг хуваалцана. Алдаа гарвал хуучин cache хэвээр. Backoff-д хамаарахгүй (админы албадан refresh). */
  reload(): Promise<Cached<T>> {
    this.inflight ??= this.fetch().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /**
   * screening-ийн замд хэрэглэх ачаалалт: таталт явж байвал түүнд нэгдэнэ; сүүлийн таталт саяхан амжилтгүй болсон бол ШИНЭ таталт эхлүүлэхгүй,
   * сануулсан алдааг даруй буцаана (дуудагч хуучин cache руу шилжинэ эсвэл 503). Үгүй бол шинэ таталт.
   */
  private reloadUnlessBackingOff(): Promise<Cached<T>> {
    if (this.inflight) return this.inflight;
    if (this.backingOff()) return Promise.reject(this.lastFailure);
    return this.reload();
  }

  private backingOff(): boolean {
    if (this.lastAttemptAt === null) return false;
    const elapsed = this.clock.now().getTime() - this.lastAttemptAt.getTime();
    // Цаг ухарсан (elapsed < 0) бол хаалтыг сунгахгүй: дахин оролдоно.
    return elapsed >= 0 && elapsed < this.config.retryBackoffMs;
  }

  status(maxStaleHours: number): AmlListStatus {
    const c = this.cached;
    return {
      list: this.list,
      version: c?.snapshot.version ?? null,
      publishedAt: c?.snapshot.publishedAt ?? null,
      fetchedAt: c?.fetchedAt.toISOString() ?? null,
      entryCount: c?.snapshot.entries.length ?? 0,
      stale: !c || this.lastError !== null || this.ageMs(c) > maxStaleHours * HOUR_MS,
      lastError: this.lastError,
    };
  }

  private async fetch(): Promise<Cached<T>> {
    try {
      const snapshot = await this.withTimeout((signal) => this.client.fetchSnapshot(signal));
      // Хоосон жагсаалт эсвэл хувилбаргүй хариу = татаж чадаагүй (хоосон жагсаалт "хэнийг ч хориглоогүй" гэж хуурамч CLEAR өгнө)
      if (!snapshot || typeof snapshot.version !== 'string' || !snapshot.version.trim() || !Array.isArray(snapshot.entries) || snapshot.entries.length === 0) {
        throw new Error(`${this.list} snapshot is empty or has no version`);
      }
      this.rejectTruncated(snapshot);
      this.cached = { snapshot, fetchedAt: this.clock.now() };
      this.lastError = null;
      this.lastFailure = null;
      this.lastAttemptAt = null;
      return this.cached;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.lastFailure = e;
      this.lastAttemptAt = this.clock.now();
      log.warn(`${this.list} list load failed: ${this.lastError}`);
      throw e;
    }
  }

  /**
   * Хэсэгчилсэн / тасарсан таталт (жнь parser тасарсан XML-ээс цөөн бичилт буцаасан) нь listed этгээдийг чимээгүй алдахгүйн тулд: өмнөх snapshot
   * >= 20 бичилттэй, шинэ нь түүний minSnapshotRatio-оос бага бол татаж чадаагүй гэж үзнэ (өмнөх cache хэвээр, degraded). Cache хоосон
   * (процесс дөнгөж асаасан) үед харьцуулах зүйлгүй тул шалгахгүй.
   */
  private rejectTruncated(snapshot: T): void {
    const previous = this.cached?.snapshot.entries.length ?? 0;
    if (previous >= TRUNCATION_GUARD_MIN_ENTRIES && snapshot.entries.length < previous * this.config.minSnapshotRatio) {
      throw new Error(`${this.list} snapshot has ${snapshot.entries.length} entries, fewer than ${this.config.minSnapshotRatio * 100}% of the previous ${previous}: rejected as truncated`);
    }
  }

  /**
   * Өлгөгдсөн (hang) таталт single-flight-аар бүх дуудагчийг барихгүй: хугацаа дуусвал AbortSignal-аар цуцалж, алдаа → хуучин cache руу
   * (<= maxStale) эсвэл 503. Цуцалсан клиент хожим буцаасан үр дүн cache-ийг дарахгүй.
   */
  private withTimeout<R>(start: (signal: AbortSignal) => Promise<R>): Promise<R> {
    const controller = new AbortController();
    // Клиент синхрон шидвэл таймер үүсгэхгүй, энгийн татгалзсан promise болгоно.
    let work: Promise<R>;
    try {
      work = start(controller.signal);
    } catch (e) {
      work = Promise.reject(e);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${this.list} snapshot fetch timed out after ${this.config.fetchTimeoutMs}ms`);
        controller.abort(error);
        reject(error);
      }, this.config.fetchTimeoutMs);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  private ageMs(c: Cached<T>): number { return this.clock.now().getTime() - c.fetchedAt.getTime(); }

  private loaded(c: Cached<T>, degraded: boolean): LoadedSnapshot<T> {
    return { snapshot: c.snapshot, fetchedAt: new Date(c.fetchedAt), degraded };
  }
}

@Injectable()
export class WatchlistService {
  private readonly un: CachedList<UnSanctionsSnapshot>;
  private readonly fatf: CachedList<FatfSnapshot>;

  constructor(
    @Inject(UN_SC_CLIENT) un: UnScClient,
    @Inject(FATF_CLIENT) fatf: FatfClient,
    @Inject(AML_CLOCK) clock: Clock,
    @Optional() @Inject(WATCHLIST_OPTIONS) options?: WatchlistOptions,
  ) {
    const config: CachedListConfig = {
      refreshMs: resolveRefreshMinutes(options) * MINUTE_MS,
      fetchTimeoutMs: resolveFetchTimeoutMs(options),
      retryBackoffMs: resolveRetryBackoffMs(options),
      minSnapshotRatio: resolveMinSnapshotRatio(options),
    };
    this.un = new CachedList('UN_SC', un, clock, config);
    this.fatf = new CachedList('FATF', fatf, clock, config);
  }

  getUn(opts: { maxStaleHours: number }): Promise<LoadedSnapshot<UnSanctionsSnapshot>> {
    return this.un.get(opts.maxStaleHours);
  }

  getFatf(opts: { maxStaleHours: number }): Promise<LoadedSnapshot<FatfSnapshot>> {
    return this.fatf.get(opts.maxStaleHours);
  }

  /** Нэг буюу хоёр жагсаалтыг албадан дахин татна. Амжилтгүй бол reject хийнэ (хуучин cache хэвээр үлдэнэ). */
  async refresh(list?: WatchedList): Promise<void> {
    const targets = list === 'UN_SC' ? [this.un] : list === 'FATF' ? [this.fatf] : [this.un, this.fatf];
    const results = await Promise.allSettled(targets.map((t) => t.reload()));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  /**
   * screening бүрт хадгалах хувилбарууд (listVersions). Хуучин cache-ээр ажиллаж байвал screen()-тэй ижил '+stale' дагавартай:
   * ингэснээр өөрчлөгдөөгүй доройтсон төлөв дахин "хуучирсан" гэж сонгогдохгүй, шинэ жагсаалт ирэхэд (дагавар алга болно) л дахин шалгана.
   */
  async currentVersions(opts: { maxStaleHours: number }): Promise<Record<string, string>> {
    const [un, fatf] = await Promise.all([this.getUn(opts), this.getFatf(opts)]);
    return { UN_SC: stampedVersion(un), FATF: stampedVersion(fatf) };
  }

  /** Cache-аас шууд (татахгүй). Хэзээ ч ачаалаагүй жагсаалт: version null, entryCount 0, stale true. */
  status(maxStaleHours: number = DEFAULT_AML_POLICY.maxStaleListHours): AmlListStatus[] {
    return [this.un.status(maxStaleHours), this.fatf.status(maxStaleHours)];
  }
}
