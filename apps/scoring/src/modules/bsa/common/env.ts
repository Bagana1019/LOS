// common/ adapter-уудын env уншигч туслахууд. Хоосон утга = тохируулаагүй (docker-compose-ийн `${VAR:-}` орлуулалтад зориулсан).
// Алдааны мессеж хувьсагчийн нэр + шалтгааныг нэрлэнэ. Нууц утгыг (түлхүүр, нууц үг) мессежид ХЭЗЭЭ Ч давтахгүй — тэдгээрийг
// задлах adapter өөрөө хариуцна; энд зөвхөн нууц биш тоо/boolean-ийн parse байна.

export type EnvLike = Readonly<Record<string, string | undefined>>;

export class EnvConfigError extends Error {
  constructor(readonly variable: string, message: string) {
    super(`${variable}: ${message}`);
    this.name = 'EnvConfigError';
  }
}

/** trim хийсэн утга; байхгүй/хоосон бол undefined */
export function envString(env: EnvLike, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

export function isProduction(env: EnvLike): boolean {
  return envString(env, 'NODE_ENV') === 'production';
}

export function parseBoolean(name: string, raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new EnvConfigError(name, `expected a boolean (true/false/1/0), got "${raw}"`);
}

const DECIMAL_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

/** Зөвхөн энгийн аравтын бичиглэл ("0.55", "20971520"): "", "0x10", "1e3", "NaN", "Infinity"-г татгалзана */
export function parseNumber(name: string, raw: string): number {
  const t = raw.trim();
  if (!DECIMAL_RE.test(t)) throw new EnvConfigError(name, `expected a plain decimal number, got "${raw}"`);
  const n = Number(t);
  if (!Number.isFinite(n)) throw new EnvConfigError(name, `number out of range: "${raw}"`);
  return n;
}

export function parseInteger(name: string, raw: string): number {
  const n = parseNumber(name, raw);
  if (!Number.isSafeInteger(n)) throw new EnvConfigError(name, `expected an integer, got "${raw}"`);
  return n;
}

/** `envBoolean(env, 'X')` → undefined | boolean */
export function envBoolean(env: EnvLike, name: string): boolean | undefined {
  const v = envString(env, name);
  return v === undefined ? undefined : parseBoolean(name, v);
}

/** Бүхэл тоо (min..max хүртэл), байхгүй бол undefined */
export function envInteger(env: EnvLike, name: string, range: { min?: number; max?: number } = {}): number | undefined {
  const v = envString(env, name);
  if (v === undefined) return undefined;
  const n = parseInteger(name, v);
  if ((range.min !== undefined && n < range.min) || (range.max !== undefined && n > range.max)) {
    throw new EnvConfigError(name, `expected an integer in [${range.min ?? '-inf'}, ${range.max ?? '+inf'}], got ${n}`);
  }
  return n;
}

/** "a, b ,c" → ['a','b','c'] (хоосон гишүүнийг алгасна) */
export function splitList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}
