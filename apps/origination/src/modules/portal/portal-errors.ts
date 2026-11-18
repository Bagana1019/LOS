import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { contextOf } from '@los/nest-common';

/**
 * portal-bff-ийн дотоод клиент (`apps/portal-bff/src/integrations/internal-http.client.ts`) алдааны биеэс зөвхөн `error.code`-г уншина
 * (400/409/422 → PASS_THROUGH код; 404 → дуудлагын `notFound`; 401/403/5xx → DOWNSTREAM_*). Тиймээс энэ модулийн хариу бүр
 * `{ error: { code, message } }` хэлбэртэй; origination-ий глобал `{ code, message }` хэлбэр энд хэрэглэгдэхгүй.
 */
export class PortalHttpError extends HttpException {
  constructor(readonly code: string, status: number, message = code) {
    super({ error: { code, message } }, status);
  }
}

export const portalError = {
  invalid: (message = 'Хүсэлт буруу') => new PortalHttpError('INVALID_REQUEST', 400, message),
  loanNotFound: () => new PortalHttpError('LOAN_NOT_FOUND', 404, 'Зээл олдсонгүй'),
  paymentNotFound: () => new PortalHttpError('PAYMENT_NOT_FOUND', 404, 'Төлбөр олдсонгүй'),
  contractNotAvailable: () => new PortalHttpError('CONTRACT_NOT_AVAILABLE', 404, 'Гэрээ олдсонгүй'),
  notFound: () => new PortalHttpError('NOT_FOUND', 404, 'Олдсонгүй'),
  notPayable: () => new PortalHttpError('LOAN_NOT_PAYABLE', 409, 'Зээл төлбөр хүлээн авах төлөвт биш'),
  noOverdue: () => new PortalHttpError('NO_OVERDUE', 409, 'Хугацаа хэтэрсэн төлбөр байхгүй'),
  amountOutOfRange: (message = 'Төлөх дүн зөвшөөрөгдөх хязгаараас гадуур') => new PortalHttpError('AMOUNT_OUT_OF_RANGE', 422, message),
  methodNotAvailable: () => new PortalHttpError('METHOD_NOT_AVAILABLE', 422, 'Төлбөрийн хэрэгсэл боломжгүй'),
  keyReused: () => new PortalHttpError('IDEMPOTENCY_KEY_REUSED', 422, 'Idempotency-Key өөр хүсэлтэд ашиглагдсан'),
  requestInProgress: () => new PortalHttpError('REQUEST_IN_PROGRESS', 409, 'Ижил хүсэлт боловсруулагдаж байна, түр хүлээгээд дахин оролдоно уу'),
  badDownstream: () => new PortalHttpError('DOWNSTREAM_INVALID_RESPONSE', 502, 'Дотоод сервисийн хариу буруу'),
};

/** origination-ий бусад модулийн (InvoiceService г.м.) бизнес кодыг portal-ийн гэрээний код руу буулгана. */
const DOMAIN_TO_PORTAL: Record<string, () => PortalHttpError> = {
  APPLICATION_NOT_FOUND: portalError.loanNotFound,
  FORBIDDEN: portalError.loanNotFound, // BOLA: харьяалахгүй бол 404 (PRT-NFR-1)
  LOAN_NOT_PAYABLE: portalError.notPayable,
  SCHEDULE_NOT_FOUND: portalError.notPayable,
  LOAN_FULLY_PAID: portalError.notPayable,
  INSTALLMENT_PAID: portalError.notPayable,
  AMOUNT_OUT_OF_RANGE: () => portalError.amountOutOfRange(),
  PROVIDER_NOT_CONFIGURED: portalError.methodNotAvailable,
  PROVIDER_NOT_IMPLEMENTED: portalError.methodNotAvailable,
  CURRENCY_NOT_SUPPORTED: portalError.methodNotAvailable,
  VALIDATION_FAILED: () => portalError.invalid(),
};

export function toPortalError(e: unknown): PortalHttpError {
  if (e instanceof PortalHttpError) return e;
  if (e instanceof HttpException) {
    const body = e.getResponse() as { code?: unknown } | string;
    const code = typeof body === 'object' && typeof body?.code === 'string' ? body.code : null;
    const mapped = code ? DOMAIN_TO_PORTAL[code] : undefined;
    if (mapped) return mapped();
    const status = e.getStatus();
    if (status === 400) return portalError.invalid();
    if (status === 404) return portalError.notFound();
    if (status === 502 || status === 503 || status === 504) return new PortalHttpError('DOWNSTREAM_UNAVAILABLE', 503, 'Түр зуурын доголдол');
    if (status === 401 || status === 403) return new PortalHttpError(code ?? 'UNAUTHENTICATED', status);
  }
  return new PortalHttpError('INTERNAL', 500, 'Дотоод алдаа');
}

/** Зөвхөн PortalController-т. Лог: код, статус, correlationId — PII (регистр, утас, OTP) хэзээ ч биш (CLAUDE.md §6-5). */
@Catch()
export class PortalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('PortalInternal');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<{ headers: Record<string, string | string[] | undefined>; method?: string; route?: { path?: string } }>();
    const res = http.getResponse<{ headersSent?: boolean; status(n: number): { json(b: unknown): void }; destroy?: () => void }>();
    const err = toPortalError(exception);
    const status = err.getStatus();
    const where = { code: err.code, status, route: req.route?.path, method: req.method, correlationId: contextOf(req as never).correlationId };
    if (status >= 500) this.logger.error({ msg: 'portal internal error', ...where, error: exception instanceof Error ? exception.name : typeof exception });
    else this.logger.warn({ msg: 'portal request rejected', ...where });
    if (res.headersSent) return void res.destroy?.();
    res.status(status).json(err.getResponse());
  }
}
