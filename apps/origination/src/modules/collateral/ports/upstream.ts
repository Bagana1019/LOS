import { DomainError, InternalHttpClient, UpstreamError, type ServiceName } from '@los/nest-common';

/**
 * Redirect дагахгүй: ctx толгой (X-Internal-Token) өөр хост руу алдагдахаас сэргийлнэ (contract/http-dms-esign.gateway.ts-тэй адил).
 */
export const noRedirectFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });

export const createInternalHttp = (env: NodeJS.ProcessEnv = process.env): InternalHttpClient => new InternalHttpClient({ env, fetchFn: noRedirectFetch });

/** CLAUDE.md §3.1: гадаад бүртгэл рүү дамжуулдаг дуудлага 15с, дотоод (dms файл мета) 3с. POST дахин оролдохгүй. */
export const EXTERNAL_TIMEOUT_MS = 15_000;
export const INTERNAL_TIMEOUT_MS = 3_000;

/**
 * Бусад дотоод сервисийн хэрэглэгчид зориулсан (монгол) тогтвортой алдаануудыг (5xx хэдий ч) хэвээр дамжуулна.
 * Жагсаалт хаалттай: үл мэдэгдэх 5xx-ийн агуулгыг (дотоод мэдээлэл агуулж болно) эргүүлэхгүй — `UpstreamError` 502/504 хэвээр.
 */
export const USER_FACING_UPSTREAM_CODES = ['XYP_UNAVAILABLE', 'INTEGRATION_NOT_IMPLEMENTED', 'ENCUMBRANCE_UNAVAILABLE', 'REGISTRY_UNAVAILABLE'] as const;

export function mapUpstreamError(service: ServiceName, e: unknown): unknown {
  // Хариу гэрээнд нийцээгүй = дотоод гэрээний зөрүү; ЗЭЗ-ийн маягтын алдаа (400 VALIDATION_FAILED) биш.
  if (e instanceof Error && e.name === 'ZodError') return new UpstreamError(service, 200, `${service}-ийн хариу гэрээнд нийцсэнгүй`, 502);
  if (e instanceof UpstreamError) {
    const body = e.upstreamBody as { code?: unknown; message?: unknown } | undefined;
    if (typeof body?.code === 'string' && typeof body.message === 'string' && (USER_FACING_UPSTREAM_CODES as readonly string[]).includes(body.code)) {
      return new DomainError(body.code, body.message, e.upstreamStatus ?? 502);
    }
  }
  return e;
}

export async function callUpstream<T>(service: ServiceName, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw mapUpstreamError(service, e);
  }
}

/** 4xx DomainError-ийн `code` нь жагсаалтад байвал өөр код/статусаар сольж, upstream-ийн монгол мессежийг хадгална. */
export function remapNotFound(e: unknown, codes: readonly string[], code: string, fallbackMessage: string): unknown {
  if (e instanceof DomainError && codes.includes(e.code) && e.getStatus() === 404) {
    const raw = e.getResponse() as { message?: unknown };
    return new DomainError(code, typeof raw.message === 'string' && raw.message ? raw.message : fallbackMessage, 422);
  }
  return e;
}
