import { UPDATE_CUSTOMER_FIELD_KEYS, type CustomerInputRaw, type CustomerView } from '@los/contracts';
import { pruneEmpty, xypLockedFields } from './customers.utils';

// F1-15: карт дээрх засвар. Сервер `PUT /customers/:id` нь хэсэгчилсэн: өгсөн талбарыг л солино, `""` = арилгах (зөвхөн заавал биш мөр), `contacts`/`employment` бүхлээр нь солигдоно,
// `customerType`/`registerNo` өгвөл 400 READONLY_FIELD. Тиймээс бие нь ЗӨВХӨН өөрчилсөн талбартай (бусад ЗЭЗ-ийн зэрэгцээ засварыг хуучин утгаар дарахгүй).

type Raw = Record<string, unknown>;
const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;

/** Картын үзүүлэлтийг (`null`-тай) маягтын анхны утга болгоно: `null`/id-г хасна. */
export function customerToFormValues(c: CustomerView): Partial<CustomerInputRaw> {
  return compact({
    lastName: c.lastName, clanName: c.clanName, civilId: c.civilId, firstName: c.firstName, gender: c.gender, birthDate: c.birthDate, phone: c.phone, email: c.email,
    photoFileId: c.photoFileId, familySize: c.familySize, activitySector: c.activitySector, maritalStatus: c.maritalStatus, segment: c.segment, education: c.education,
    isRelatedParty: c.isRelatedParty, isPep: c.isPep, residenceSameAsOfficial: c.residenceSameAsOfficial,
    officialAddress: c.officialAddress, residenceAddress: c.residenceSameAsOfficial ? null : c.residenceAddress,
    employment: c.employment ? compact(c.employment) : null,
    contacts: c.contacts.map(({ id: _id, ...contact }) => compact(contact)),
  }) as Partial<CustomerInputRaw>;
}

/**
 * ХУР-аас татсан харилцагчийн эрх бүхий талбарууд (овог нэр, төрсөн огноо, албан ёсны хаяг…) засагдахгүй — бүртгэх үеийн түгжээтэй ижил.
 * Сервер PUT дээр түгжихгүй (зөвхөн `create` 400 XYP_FIELD_READONLY) тул энэ нь UI-ийн дүрэм. Талбар тус бүрийн гарал үүсэл хадгалагддаггүй: `xypFetchedAt` + утгатай эсэхээр таана.
 */
export function xypLockedPrefill(c: CustomerView): string[] {
  if (!c.xypFetchedAt) return [];
  const filled = Object.entries(c).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k]) => k);
  return [...xypLockedFields(filled)];
}

const canon = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canon);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canon(x)]));
  return v;
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canon(pruneEmpty(a))) === JSON.stringify(canon(pruneEmpty(b)));

/** Маягт хоосон талбарыг хасдаг тул хоосон болгосныг сервер «өөрчлөхгүй» гэж ойлгоно; арилгах боломжтой (заавал биш) мөр талбарууд. */
const CLEARABLE_TEXT: readonly string[] = ['clanName', 'civilId'];

/** `payload` = маягтын `buildPayload` үр дүн; `initial` = `customerToFormValues`. Үр дүн нь PUT-ийн бие (өөрчлөлтгүй бол `{}`). */
export function buildUpdateBody(payload: Raw, initial: Partial<CustomerInputRaw>): Raw {
  const before = initial as Raw;
  const entries = UPDATE_CUSTOMER_FIELD_KEYS.flatMap((key): [string, unknown][] => {
    const next = payload[key];
    if (same(next, before[key])) return [];
    if (pruneEmpty(next) !== undefined) return [[key, next]];
    if (key === 'contacts') return [[key, []]];
    return CLEARABLE_TEXT.includes(key) ? [[key, '']] : [];
  });
  return Object.fromEntries(entries);
}
