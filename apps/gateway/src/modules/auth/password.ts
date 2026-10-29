import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt (Node-д суурилсан, native dependency-гүй). Формат: `scrypt$<logN>$<r>$<p>$<salt b64>$<hash b64>` — параметр нь hash дотор тул
// дараа нь чангалахад хуучин нууц үгүүд ажилласаар, нэвтрэхэд `needsRehash`-аар шинэчлэгдэнэ. OWASP: N=2^15, r=8, p=3.
const DEFAULT = { logN: 15, r: 8, p: 3 };
const KEYLEN = 32;

const params = () => (process.env.NODE_ENV === 'test' && process.env.PASSWORD_SCRYPT_LOG_N ? { ...DEFAULT, logN: Number(process.env.PASSWORD_SCRYPT_LOG_N), p: 1 } : DEFAULT);
const derive = (password: string, salt: Buffer, logN: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => {
    const opts: ScryptOptions = { N: 2 ** logN, r, p, maxmem: 256 * 2 ** logN * r };
    scrypt(password.normalize('NFKC'), salt, KEYLEN, opts, (e, k) => (e ? reject(e) : resolve(k)));
  });

export async function hashPassword(password: string): Promise<string> {
  const { logN, r, p } = params();
  const salt = randomBytes(16);
  return ['scrypt', logN, r, p, salt.toString('base64'), (await derive(password, salt, logN, r, p)).toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, logN, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !logN || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(logN), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function needsRehash(stored: string): boolean {
  const [, logN, r, p] = stored.split('$');
  const t = params();
  return Number(logN) < t.logN || Number(r) < t.r || Number(p) < t.p;
}

/** Хэрэглэгч олдоогүй үед ч ижил хугацаа зарцуулахын тулд (username enumeration-аас хамгаалах). */
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashPassword('not-a-real-password'));
