// FR-11.4 Линкийн токен: 32 санамсаргүй байт → base64url (43 тэмдэгт). DB-д ЗӨВХӨН sha256(token) hex хадгална; токеныг лог/audit-д бичихгүй.
import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
/** base64url(32 байт) = 43 тэмдэгт, padding-гүй */
export const LINK_TOKEN_LENGTH = 43;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function generateLinkToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Public endpoint-д ирсэн дурын утгыг hash хийх/DB рүү явуулахаас өмнө хэлбэрийг нь шалгана */
export function isLinkTokenShape(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
