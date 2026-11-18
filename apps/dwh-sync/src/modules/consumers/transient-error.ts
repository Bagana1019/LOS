// HIGH (C3): classify DWH failures for the bus (`isTransientError`). Transient = the DWH (or the path to it) is unavailable right now:
// the message stays pending without consuming a delivery attempt. Everything else is deterministic and counts toward the DLQ.
const NET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED']);
// SQLSTATE classes 08 connection, 53 insufficient resources, 57P0x shutdown, 58 system, 28 auth, 3D000 missing db.
const PG_CLASSES = ['08', '53', '58', '28'];
// 40001/40P01/55P03 retryable concurrency; 42P01/42703 = DWH schema behind the code — an operator fix, never a reason to drop events.
const PG_CODES = new Set(['57P01', '57P02', '57P03', '3D000', '40001', '40P01', '55P03', '42P01', '42703']);
const PG_DRIVER_MESSAGES = /Connection terminated|timeout exceeded when trying to connect|connection error|Cannot use a pool after calling end/i;
const MAX_DEPTH = 5;

const codeIsTransient = (code: unknown): boolean =>
  typeof code === 'string' && (NET_CODES.has(code) || PG_CODES.has(code) || (/^[0-9A-Z]{5}$/.test(code) && PG_CLASSES.includes(code.slice(0, 2))));

export function isTransientDwhError(err: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  if (codeIsTransient(e.code)) return true;
  if (typeof e.message === 'string' && PG_DRIVER_MESSAGES.test(e.message)) return true;
  if (Array.isArray(e.errors) && e.errors.length > 0 && e.errors.every((x) => isTransientDwhError(x, depth + 1))) return true;
  return e.cause !== err && isTransientDwhError(e.cause, depth + 1);
}
