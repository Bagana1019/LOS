// Модуль 8 (underwriting + sosco) HTTP-ийн нийтлэг хэсэг: алдааны код, zod pipe, хэрэглэгчийн шалгалт.
// Алдааны хэлбэр — foundation: `{ code, message, details?, correlationId }` (nest-common AllExceptionsFilter). BSA-ийн global
// `BsaExceptionFilter` (main.ts `configureBsaApp`) домэйн кодыг статусын нийтлэг код руу буулгадаг тул controller бүр
// `@UseFilters(AllExceptionsFilter)`-ээр өөрийн хариуг баталгаажуулна (controller-ийн filter нь global-аас түрүүлнэ).
import { HttpStatus, UnauthorizedException, type PipeTransform } from '@nestjs/common';
import type { ScoringErrorCode, RequestContext } from '@los/contracts';
import { DomainError } from '@los/nest-common';
import type { ZodError, ZodTypeAny, z } from 'zod';

/** Тогтвортой код (`SCORING_ERROR_CODES`) + монгол мессеж */
export const scoringError = (code: ScoringErrorCode, message: string, status: number, details?: unknown): DomainError => new DomainError(code, message, status, details);

export const calculationNotFound = (): DomainError => scoringError('CALCULATION_NOT_FOUND', 'Тооцоолол олдсонгүй', HttpStatus.NOT_FOUND);
export const calculationStale = (): DomainError =>
  scoringError('CALCULATION_STALE', 'Тооцоолол хуучирсан байна. Дахин тооцоолсны дараа арга сонгоно уу', HttpStatus.CONFLICT);
export const methodNotApplicable = (method: string): DomainError =>
  scoringError('METHOD_NOT_APPLICABLE', 'Сонгосон аргад орлогын суурь байхгүй тул сонгох боломжгүй', HttpStatus.UNPROCESSABLE_ENTITY, { method });

/** Нэг хүсэлтэд хэт олон issue буцаахгүй */
const MAX_ISSUES = 20;

/** 400 VALIDATION_FAILED. `details` нь ЗӨВХӨН зам + zod код — ирсэн утга (орлого, ID …) хэзээ ч эргэж гарахгүй */
export function validationFailed(error: ZodError): DomainError {
  return new DomainError('VALIDATION_FAILED', 'Оруулсан өгөгдөл буруу', HttpStatus.BAD_REQUEST, error.issues.slice(0, MAX_ISSUES).map((i) => ({ path: i.path.join('.'), code: i.code })));
}

/** `@Body(new ScoringZodPipe(Schema))` — nest-common ZodValidationPipe-оос ялгаа: zod-ын мессеж (enum-д ирсэн утгыг агуулдаг) хариунд орохгүй */
export class ScoringZodPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}
  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) throw validationFailed(parsed.error);
    return parsed.data;
  }
}

/** Бичих үйлдэл нь хариуцагчтай (NFR-4 аудит): gateway-ээс `X-User-Id` ирээгүй бол татгалзана */
export function requireUserId(ctx: Pick<RequestContext, 'userId'>): string {
  if (!ctx.userId) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Хэрэглэгч тодорхойлогдоогүй байна' });
  return ctx.userId;
}

/** Транзакцийн хугацаа: нэг (org, application)-ийн зэрэг бичилтүүд advisory lock дээр дараалж хүлээнэ */
export const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;
