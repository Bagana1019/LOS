import type { MakerCheckerErrorCode } from '@los/contracts';
import { DomainError } from '@los/nest-common';

// MC-FR-8: алдааны код тогтмол (UI mn.json-д орчуулагдана), message нь монгол.
export type { MakerCheckerErrorCode };
export const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  MAKER_ROLE_FORBIDDEN: 403,
  SELF_APPROVAL_FORBIDDEN: 403,
  CHECKER_ROLE_FORBIDDEN: 403,
  CHECKER_BRANCH_FORBIDDEN: 403,
  ONLY_MAKER_CAN_CANCEL: 403,
  NOT_FOUND: 404,
  ALREADY_DECIDED: 409,
  EXPIRED: 409,
  TARGET_HAS_PENDING_CHANGE: 409,
  STALE_TARGET: 409,
  DECISION_IN_PROGRESS: 409,
  VALIDATION_FAILED: 400,
  HANDLER_NOT_FOUND: 422,
  PAYLOAD_INVALID: 422,
  TARGET_ID_MISMATCH: 422,
  POLICY_LOCKED: 422,
} as const satisfies Record<MakerCheckerErrorCode, number>; // @los/contracts-ийн кодын жагсаалттай бүрэн тохирно (дутуу/илүү түлхүүр = compile алдаа)

/**
 * Foundation-ийн `DomainError` (HttpException) — домэйн модулийн контроллер `makerChecker.submit()`-ийг дуудахад ч
 * `AllExceptionsFilter` өөрөө 401/403/404/409/422 болгож `{code, message, details?, correlationId}` хэлбэрээр хариулна.
 */
export class MakerCheckerError extends DomainError {
  declare readonly code: MakerCheckerErrorCode;
  constructor(code: MakerCheckerErrorCode, message: string, details?: unknown) {
    super(code, message, ERROR_STATUS[code], details);
  }
}

export const MESSAGES: Record<MakerCheckerErrorCode, string> = {
  UNAUTHENTICATED: 'Хэрэглэгч таниагүй (X-User-Id шаардлагатай)',
  FORBIDDEN: 'Энэ үйлдэлд эрх хүрэлцэхгүй',
  MAKER_ROLE_FORBIDDEN: 'Энэ өөрчлөлтийг санал болгох эрхгүй',
  SELF_APPROVAL_FORBIDDEN: 'Өөрийн үүсгэсэн хүсэлтийг өөрөө батлах/татгалзах боломжгүй (4 нүдний зарчим)',
  CHECKER_ROLE_FORBIDDEN: 'Энэ хүсэлтийг батлах эрхгүй (шаардлагатай дүр биш)',
  CHECKER_BRANCH_FORBIDDEN: 'Энэ хүсэлт өөр салбарынх тул батлах боломжгүй',
  ONLY_MAKER_CAN_CANCEL: 'Хүсэлтийг зөвхөн үүсгэсэн хэрэглэгч цуцалж болно',
  NOT_FOUND: 'Хүсэлт олдсонгүй',
  ALREADY_DECIDED: 'Хүсэлт аль хэдийн шийдвэрлэгдсэн',
  EXPIRED: 'Хүсэлтийн хугацаа дууссан',
  TARGET_HAS_PENDING_CHANGE: 'Энэ зүйлд хүлээгдэж буй өөр өөрчлөлт байна — түүнийг шийдвэрлэсний дараа дахин илгээнэ үү',
  STALE_TARGET: 'Өгөгдөл санал болгосноос хойш өөрчлөгдсөн тул хэрэгжүүлсэнгүй — шинэ мэдээллээр дахин илгээнэ үү',
  DECISION_IN_PROGRESS: 'Энэ хүсэлтийг одоо өөр хэрэглэгч шийдвэрлэж байна — түр хүлээгээд дахин оролдоно уу',
  VALIDATION_FAILED: 'Хүсэлтийн өгөгдөл буруу',
  HANDLER_NOT_FOUND: 'Ийм төрлийн өөрчлөлтийг дэмжихгүй (targetType/action бүртгэгдээгүй)',
  PAYLOAD_INVALID: 'Өөрчлөлтийн агуулга буруу',
  TARGET_ID_MISMATCH: 'targetId нь агуулгатай таарахгүй байна',
  POLICY_LOCKED: 'Энэ өөрчлөлтийн 4 нүдний хяналтыг идэвхгүй болгох боломжгүй',
};

export const err = (code: MakerCheckerErrorCode, details?: unknown, message?: string) =>
  new MakerCheckerError(code, message ?? MESSAGES[code], details);
