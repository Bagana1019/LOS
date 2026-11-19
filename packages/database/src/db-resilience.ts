// M8: Postgres түр тасрах (crash recovery, restart) үед сервисүүд унахгүй, DB буцаж ирэхэд restart-гүй сэргэнэ.
// Нэг газар: transient алдааны ангилагч (HTTP 503, event bus, outbox relay, startup retry бүгд үүнийг ашиглана) + хязгаартай connect retry.
// Prisma-аас хамааралгүй (сервис бүр өөрийн generated client-тэй) — алдааг нэр/кодоор нь таниулна.

/** Prisma: P1001 сервер хүрэхгүй, P1002 хугацаа хэтэрсэн, P1008 үйлдлийн timeout, P1017 сервер холболт хаасан, P2024 pool-оос холболт авч чадсангүй. */
const PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
const NET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'EAI_AGAIN']);
/** SQLSTATE: 57P01 admin shutdown, 57P02 crash shutdown, 57P03 starting up; 08xxx connection exception анги. */
const PG_CODES = new Set(['57P01', '57P02', '57P03']);
const CONNECTION_MESSAGE = /can't reach database server|server has closed the connection|connection (reset|refused|closed|terminated)|connection error|broken pipe/i;
const MAX_DEPTH = 5;

interface ErrorLike { name?: unknown; code?: unknown; errorCode?: unknown; message?: unknown; meta?: { code?: unknown } | null; cause?: unknown }

const isConnectionCode = (code: unknown): boolean =>
  typeof code === 'string' && (PRISMA_CODES.has(code) || NET_CODES.has(code) || PG_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code));

/** Түр зуурын (дахин оролдвол болох) DB холболтын алдаа эсэх. Validation/constraint/өгөгдлийн алдаа хэзээ ч transient биш. */
export function isTransientDbError(err: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || typeof err !== 'object' || err === null) return false;
  const e = err as ErrorLike;
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (name === 'PrismaClientInitializationError') return true;
  if (name === 'DbOperationError' && e.code === 'INIT') return true; // dms sanitizeDbError(PrismaClientInitializationError)
  if (isConnectionCode(e.code) || isConnectionCode(e.errorCode) || isConnectionCode(e.meta?.code)) return true;
  if ((name === 'PrismaClientRustPanicError' || name === 'PrismaClientUnknownRequestError') && CONNECTION_MESSAGE.test(message)) return true;
  return e.cause !== err && isTransientDbError(e.cause, depth + 1);
}

/** Лог-д аюулгүй товч тодорхойлолт: зөвхөн нэр + код (мессеж нь host/connection string агуулж болзошгүй). */
export function describeDbError(err: unknown): string {
  if (typeof err !== 'object' || err === null) return typeof err;
  const e = err as ErrorLike;
  const code = [e.errorCode, e.code, e.meta?.code].find((c) => typeof c === 'string');
  return `${typeof e.name === 'string' ? e.name : 'Error'}${code ? ` (${String(code)})` : ''}`;
}

export interface BackoffOptions { initialDelayMs: number; maxDelayMs: number }

/** Exponential backoff + full jitter: [0, min(max, initial·2^attempt)]. */
export function backoffDelayMs(attempt: number, o: BackoffOptions, random: () => number = Math.random): number {
  const cap = Math.min(o.maxDelayMs, o.initialDelayMs * 2 ** Math.min(attempt, 30));
  return Math.round(cap * random());
}

export interface ConnectRetryOptions extends BackoffOptions {
  /** Нийт хүлээх хугацааны дээд хязгаар; хэтэрвэл сүүлийн алдааг шиднэ (процесс non-zero exit → orchestrator restart). */
  maxWaitMs: number;
  random?: () => number;
  log?: { warn(msg: string): void };
}

const DEFAULTS = { maxWaitMs: 60_000, initialDelayMs: 500, maxDelayMs: 10_000 };
const positive = (v: string | undefined, fallback: number) => { const n = Number(v); return v !== undefined && Number.isFinite(n) && n > 0 ? n : fallback; };

/** `DB_CONNECT_MAX_WAIT_MS`, `DB_CONNECT_INITIAL_DELAY_MS`, `DB_CONNECT_MAX_DELAY_MS` (буруу утга → анхдагч). */
export function connectRetryOptionsFromEnv(env: Record<string, string | undefined> = process.env): Pick<ConnectRetryOptions, 'maxWaitMs' | 'initialDelayMs' | 'maxDelayMs'> {
  return {
    maxWaitMs: positive(env.DB_CONNECT_MAX_WAIT_MS, DEFAULTS.maxWaitMs),
    initialDelayMs: positive(env.DB_CONNECT_INITIAL_DELAY_MS, DEFAULTS.initialDelayMs),
    maxDelayMs: positive(env.DB_CONNECT_MAX_DELAY_MS, DEFAULTS.maxDelayMs),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Startup холболт: transient алдаанд backoff-оор дахин оролдоно, хугацааны төсөв дуусвал / transient биш алдаанд шууд шиднэ. */
export async function connectWithRetry(connect: () => Promise<unknown>, opts: Partial<ConnectRetryOptions> = {}): Promise<void> {
  const o = { ...connectRetryOptionsFromEnv(), ...opts };
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      await connect();
      return;
    } catch (err) {
      const delay = backoffDelayMs(attempt, o, o.random);
      if (!isTransientDbError(err) || Date.now() - started + delay > o.maxWaitMs) throw err;
      o.log?.warn(`DB connect failed: ${describeDbError(err)}; retry #${attempt + 1} in ${delay} ms`);
      await sleep(delay);
    }
  }
}

/** PrismaService.onModuleInit-д: `await connectPrismaWithRetry(this, new Logger('Prisma'))`. */
export function connectPrismaWithRetry(client: { $connect(): Promise<void> }, log?: { warn(msg: string): void }): Promise<void> {
  return connectWithRetry(() => client.$connect(), { log });
}
