// WS100101 getCitizenIDCardInfo-ийн `response` → LOS `XypCitizen`. Цэвэр функц: I/O байхгүй.
// Зөвхөн gsb-ийн тест fixture-ээр НОТЛОГДСОН талбарыг уншина (gsb-ийн «олон нэрээр хайх» таамаглалуудыг авахгүй):
// firstname, lastname, gender, birthDateAsText | birthDate, civilId, aimagCityName, soumDistrictName, bagKhorooName,
// addressStreetName, addressApartmentName, addressDetail | addressDoor, passportAddress. `image` (зураг) зориуд ТАТАХГҮЙ (PII, гэрээнд байхгүй).
// ХУР-д байхгүй: clanName, maritalStatus, familySize, activitySector → null (мэдэгдэхгүй ≠ зохиох).
import { XypCitizen } from '@los/contracts';
import { XypUnavailableError } from './xyp.client';

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Хоосон биш string (trim) эсвэл төгсгөлөг тоо → string; бусад → null. */
function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
}

function gender(v: unknown): 'MALE' | 'FEMALE' | null {
  const g = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (['эрэгтэй', 'male', 'man', 'm'].includes(g)) return 'MALE';
  if (['эмэгтэй', 'female', 'woman', 'f'].includes(g)) return 'FEMALE';
  return null;
}

const isRealDate = (ymd: string): boolean => {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

/** `birthDateAsText` ("YYYY-MM-DD HH:MM") найдвартай; үгүй бол `birthDate` (Date эсвэл ISO). Огноог цагийн бүсээр хөрвүүлэхгүй. */
function birthDate(r: Row): string | null {
  const candidates: unknown[] = [r.birthDateAsText, r.birthDate instanceof Date && !Number.isNaN(r.birthDate.getTime()) ? r.birthDate.toISOString() : r.birthDate];
  for (const c of candidates) {
    const m = typeof c === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(c.trim()) : null;
    if (m && isRealDate(m[1]!)) return m[1]!;
  }
  return null;
}

/** Бүтэцтэй хаяг: аймаг/хот, дүүрэг/сум, хороо/баг заавал; аль нэг нь дутвал null (албан тушаалтан гараар бөглөнө). */
function address(r: Row): { province: string; district: string; khoroo: string; detail: string } | null {
  const province = str(r.aimagCityName);
  const district = str(r.soumDistrictName);
  const khoroo = str(r.bagKhorooName);
  const detail = [str(r.addressStreetName), str(r.addressApartmentName), str(r.addressDetail) ?? str(r.addressDoor)].filter(Boolean).join(', ') || str(r.passportAddress);
  return province && district && khoroo && detail ? { province, district, khoroo, detail } : null;
}

const MALFORMED = 'ХУР-ын хариуны хэлбэр буруу байна';

export function mapCitizenResponse(registerNo: string, response: unknown, fetchedAt: Date): XypCitizen {
  if (!isRow(response)) throw new XypUnavailableError(MALFORMED);
  const firstName = str(response.firstname);
  if (!firstName) throw new XypUnavailableError(MALFORMED); // нэргүй хариуноос зохиомол иргэн үүсгэхгүй
  const candidate = {
    registerNo, customerType: 'INDIVIDUAL' as const, lastName: str(response.lastname), firstName, clanName: null, civilId: str(response.civilId),
    gender: gender(response.gender), birthDate: birthDate(response), maritalStatus: null, familySize: null, activitySector: null,
    address: address(response), fetchedAt: fetchedAt.toISOString(),
  };
  const parsed = XypCitizen.safeParse(candidate);
  if (parsed.success) return parsed.data;
  // Хаяг гэрээний хязгаараас (урт) хэтэрвэл тасалж гажуудуулахгүй: хаягийг null болгоно.
  const withoutAddress = XypCitizen.safeParse({ ...candidate, address: null });
  if (candidate.address && withoutAddress.success) return withoutAddress.data;
  throw new XypUnavailableError(MALFORMED);
}
