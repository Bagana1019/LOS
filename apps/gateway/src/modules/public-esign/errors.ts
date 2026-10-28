import { HttpException } from '@nestjs/common';

// Public e-sign proxy-ийн алдааны нэгдсэн хэлбэр: `{ code, message }` (message — монгол). Дотоод мэдээлэл (URL, stack, порт) хэзээ ч гарахгүй.

export type PublicErrorCode =
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'UPSTREAM_UNAVAILABLE'
  | 'REQUEST_REJECTED'
  | 'INTERNAL_ERROR';

export const PUBLIC_ERRORS: Readonly<Record<PublicErrorCode, { status: number; message: string }>> = {
  NOT_FOUND: { status: 404, message: 'Хүссэн мэдээлэл олдсонгүй.' },
  RATE_LIMITED: { status: 429, message: 'Хэт олон хүсэлт илгээлээ. Түр хүлээгээд дахин оролдоно уу.' },
  PAYLOAD_TOO_LARGE: { status: 413, message: 'Хүсэлтийн хэмжээ хэт том байна.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'Дэмжигдэхгүй хүсэлтийн төрөл байна.' },
  UPSTREAM_UNAVAILABLE: { status: 502, message: 'Үйлчилгээ түр хугацаанд боломжгүй байна. Түр хүлээгээд дахин оролдоно уу.' },
  REQUEST_REJECTED: { status: 400, message: 'Хүсэлтийг боловсруулах боломжгүй байна.' },
  INTERNAL_ERROR: { status: 500, message: 'Системийн алдаа гарлаа. Дахин оролдоно уу.' },
};

export class PublicEsignError extends HttpException {
  constructor(
    readonly code: PublicErrorCode,
    /** Хариунд нэмэх толгой, жишээ нь `Retry-After` */
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    const { status, message } = PUBLIC_ERRORS[code];
    super({ code, message }, status);
  }
}
