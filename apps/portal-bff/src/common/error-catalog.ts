import type { PortalErrorCode } from '@los/contracts';

// Код → HTTP төлөв + харилцагчид харуулах монгол мессеж (UI мөр i18n-тэй адил монгол кирилл).
export const ERROR_CATALOG: Record<PortalErrorCode, { status: number; message: string }> = {
  INVALID_REQUEST: { status: 400, message: 'Хүсэлтийн мэдээлэл буруу байна.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Хүсэлтийн хэмжээ хэт том байна.' },
  NOT_FOUND: { status: 404, message: 'Хаяг олдсонгүй.' },
  UNAUTHENTICATED: { status: 401, message: 'Нэвтрэх шаардлагатай эсвэл нэвтрэлтийн хугацаа дууссан байна.' },
  RATE_LIMITED: { status: 429, message: 'Хэт олон оролдлого хийлээ. Түр хүлээгээд дахин оролдоно уу.' },
  OTP_INVALID: { status: 400, message: 'Баталгаажуулах код буруу байна.' },
  OTP_EXPIRED: { status: 400, message: 'Баталгаажуулах кодын хугацаа дууссан. Шинэ код авна уу.' },
  OTP_ATTEMPTS_EXCEEDED: { status: 429, message: 'Буруу код олон удаа оруулсан. Шинэ код авна уу.' },
  LOAN_NOT_FOUND: { status: 404, message: 'Зээл олдсонгүй.' },
  PAYMENT_NOT_FOUND: { status: 404, message: 'Төлбөр олдсонгүй.' },
  CONTRACT_NOT_AVAILABLE: { status: 404, message: 'Гэрээний файл бэлэн болоогүй байна.' },
  LOAN_NOT_PAYABLE: { status: 409, message: 'Энэ зээлд төлөлт хийх боломжгүй байна.' },
  NO_OVERDUE: { status: 409, message: 'Хугацаа хэтэрсэн төлбөр байхгүй байна.' },
  AMOUNT_OUT_OF_RANGE: { status: 422, message: 'Төлөх дүн зөвшөөрөгдсөн хязгаараас гадна байна.' },
  METHOD_NOT_AVAILABLE: { status: 422, message: 'Сонгосон төлбөрийн хэрэгсэл ашиглах боломжгүй байна.' },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, message: 'Idempotency-Key толгой заавал шаардлагатай.' },
  IDEMPOTENCY_KEY_REUSED: { status: 422, message: 'Энэ Idempotency-Key өөр агуулгатай хүсэлтэд ашиглагдсан байна.' },
  REQUEST_IN_PROGRESS: { status: 409, message: 'Хүсэлт боловсруулагдаж байна. Түр хүлээнэ үү.' },
  DOWNSTREAM_UNAVAILABLE: { status: 503, message: 'Үйлчилгээ түр хүлээн авах боломжгүй байна. Дахин оролдоно уу.' },
  DOWNSTREAM_INVALID_RESPONSE: { status: 502, message: 'Үйлчилгээнээс буруу хариу ирлээ. Дахин оролдоно уу.' },
  INTERNAL: { status: 500, message: 'Системийн алдаа гарлаа. Дахин оролдоно уу.' },
};

/** Downstream-ээс ирсэн бизнес алдааны кодуудаас зөвхөн эдгээрийг харилцагч руу дамжуулна. */
export const PASS_THROUGH_DOWNSTREAM_CODES = new Set<PortalErrorCode>([
  'INVALID_REQUEST', // жишээ нь origination мэдэхгүй cursor
  'LOAN_NOT_PAYABLE',
  'NO_OVERDUE',
  'AMOUNT_OUT_OF_RANGE',
  'METHOD_NOT_AVAILABLE',
  'CONTRACT_NOT_AVAILABLE',
  'IDEMPOTENCY_KEY_REUSED',
  'REQUEST_IN_PROGRESS',
]);
