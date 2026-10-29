// API error model. The gateway answers {statusCode, code, message, details?} with a Mongolian message.
import { mn } from '@los/ui';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const dict: Record<string, string> = mn;

function mappedMessage(code: string): string | undefined {
  const key = `maker_checker.error.${code}`;
  return Object.hasOwn(dict, key) ? dict[key] : undefined;
}

function bodyMessage(body: Record<string, unknown>): string | undefined {
  const m = body.message;
  const text = Array.isArray(m) ? m.filter((x) => typeof x === 'string').join('; ') : m;
  return typeof text === 'string' && text.trim() ? text.trim() : undefined;
}

/**
 * Build an ApiError from a non-2xx response body.
 * The server message is shown only when the body is one of our structured errors (has a `code`):
 * proxies and frameworks answer with English text we do not want to show. Otherwise a mapped
 * mn.json string for the code, then a generic one.
 */
export function buildApiError(status: number, body: unknown): ApiError {
  const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const structured = typeof obj.code === 'string' && obj.code !== '';
  const code = structured ? (obj.code as string) : `HTTP_${status}`;
  const message = (structured ? bodyMessage(obj) : undefined) ?? mappedMessage(code) ?? mn['maker_checker.error.generic'];
  return new ApiError(status, code, message, obj.details);
}

/** User-presentable text for anything thrown by the API layer. */
export function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : mn['maker_checker.error.generic'];
}

export const isApiError = (e: unknown, status: number): boolean => e instanceof ApiError && e.status === status;
export const isForbidden = (e: unknown): boolean => isApiError(e, 403);
/** 409: already decided / expired / stale target - the data on screen is out of date. */
export const isConflict = (e: unknown): boolean => isApiError(e, 409);
