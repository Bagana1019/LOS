import { CustomerInput } from '@los/contracts';

/** Хоосон мөр / null / хоосон объект / хоосон массивыг хасна: сервер `""`-г "оруулаагүй" гэж ойлгодог ч бүтэн объект (хаяг, хөдөлмөр) хагас хоосон байж болохгүй. */
export function pruneEmpty(value: unknown): unknown {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value;
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const items = value.map(pruneEmpty).filter((v) => v !== undefined);
    return items.length ? items : undefined;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = pruneEmpty(v);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

export type FieldIssue = { name: (string | number)[]; message: string };

/** Бүтэн объект (хаяг/хөдөлмөр) дутсан бол эхний дэд талбарыг тэмдэглэнэ, ингэснээр маягт дээр улаанаар харагдана. */
const FIRST_CHILD: Record<string, string> = { officialAddress: 'province', residenceAddress: 'province', employment: 'organization' };

export function issuePath(path: readonly (string | number)[] | string): (string | number)[] {
  const parts = typeof path === 'string' ? path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s)) : [...path];
  const head = parts[0];
  if (parts.length === 1 && typeof head === 'string' && FIRST_CHILD[head]) parts.push(FIRST_CHILD[head] as string);
  return parts;
}

/**
 * Нэг л газар (contracts-ийн `CustomerInput`) шалгана — сервертэй ижил дүрэм.
 * Zod нь талбарын хэлбэр буруу бол заавал талбарын (superRefine) шалгалтыг ажиллуулдаггүй тул, буруу талбарыг түр хасаад дахин шалгаж
 * бүх алдааг НЭГЭН ЗЭРЭГ буцаана (хэрэглэгч нэг нэгээр нь биш бүгдийг нэг дор харна).
 */
export function validateCustomer(payload: Record<string, unknown>): FieldIssue[] {
  const out: FieldIssue[] = [];
  const seen = new Set<string>();
  let current = { ...payload };
  for (let round = 0; round < 8; round++) {
    const r = CustomerInput.safeParse(current);
    if (r.success) break;
    let progressed = false;
    for (const i of r.error.issues) {
      const name = issuePath(i.path as (string | number)[]);
      const key = name.join('.');
      if (!seen.has(key)) { seen.add(key); out.push({ name, message: i.message }); }
      const top = i.path[0];
      if (typeof top === 'string' && top in current && top !== 'customerType' && top !== 'registerNo') { delete current[top]; progressed = true; }
    }
    // firstName дутуу бол superRefine ажиллахгүй: түр нөхөж үлдсэн заавал талбарыг мөн шалгана
    if (!progressed) {
      if (!('firstName' in current)) { current = { ...current, firstName: '_' }; continue; }
      break;
    }
  }
  return out;
}

/** Маягтын утгаас сервер рүү явах биеийг үүсгэнэ. */
export function buildPayload(values: Record<string, unknown>, fixed: { customerType: string; registerNo: string }): Record<string, unknown> {
  const pruned = (pruneEmpty(values) ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...pruned, ...fixed };
  // Тэмдэглэгээ нь хоосон байхад false байх ёстой (pruneEmpty false-г хасахгүй)
  out.isPep = Boolean(values.isPep);
  out.isRelatedParty = Boolean(values.isRelatedParty);
  out.residenceSameAsOfficial = Boolean(values.residenceSameAsOfficial);
  if (out.residenceSameAsOfficial) delete out.residenceAddress;
  return out;
}
