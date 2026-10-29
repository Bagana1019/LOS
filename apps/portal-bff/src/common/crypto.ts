import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Түлхүүртэй хэш: регистр, утас, OTP-ийг Redis түлхүүр/бичлэгт plain хэлбэрээр хадгалахгүйн тулд. */
export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

/** Урт нь ялгаатай байсан ч алдаа гаргахгүй, тогтмол хугацаанд харьцуулна. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
