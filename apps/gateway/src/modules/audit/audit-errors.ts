// M10 — аудит бичилтийн алдааг ангилна: transient (холболт, timeout, түгжээ) → дараалалд үлдээж дахин оролдоно;
// permanent (утга/схемийн алдаа) → дахин оролдоод нэмэргүй, DLQ руу. Тодорхойгүй алдаа = transient (хэзээ ч алдагдуулахгүй).
// Ангилал (`auditErrorClass`) нь зөвхөн код/нэр — алдааны мессеж (утга агуулж болзошгүй) хадгалагдахгүй.

/** Prisma-гийн утга/схемийн алдааны кодууд (дахин оролдоход засрахгүй). */
const PERMANENT_PRISMA = new Set(['P2000', 'P2005', 'P2006', 'P2007', 'P2011', 'P2012', 'P2019', 'P2020', 'P2023', 'P2033']);
/** Postgres SQLSTATE анги: 22 data exception, 23 integrity, 42 syntax/undefined, 2F/39 routine. */
const PERMANENT_SQLSTATE = /^(22|23|42|2F|39)/;
const SQLSTATE_IN_MESSAGE = /code:\s*"([0-9A-Z]{5})"/;

type ErrLike = { name?: unknown; code?: unknown; meta?: { code?: unknown }; message?: unknown };

function sqlState(e: ErrLike): string | null {
  if (typeof e.meta?.code === 'string') return e.meta.code;
  const m = typeof e.message === 'string' ? SQLSTATE_IN_MESSAGE.exec(e.message) : null;
  return m?.[1] ?? null;
}

/** null = transient (эсвэл тодорхойгүй); string = байнгын алдааны анги. */
function permanentClass(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as ErrLike;
  if (e.name === 'PrismaClientValidationError') return 'PrismaClientValidationError';
  const state = sqlState(e);
  if (state) return PERMANENT_SQLSTATE.test(state) ? `PG_${state}` : null;
  if (typeof e.code === 'string' && PERMANENT_PRISMA.has(e.code)) return e.code;
  return null;
}

export const isTransientAuditError = (err: unknown): boolean => permanentClass(err) === null;

/** DLQ-д бичих анги (PII-гүй): permanent бол түүний код, үгүй бол нэр. */
export function auditErrorClass(err: unknown): string {
  const p = permanentClass(err);
  if (p) return p;
  const e = (err && typeof err === 'object' ? err : {}) as ErrLike;
  return typeof e.code === 'string' ? e.code : typeof e.name === 'string' ? e.name : 'UNKNOWN';
}
