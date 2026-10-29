import type { CustomerAddress, Gender, MaritalStatus, XypCitizen } from '@los/contracts';
import { customerTypeOfRegister } from '@los/contracts';

// Deterministic mock (CLAUDE.md §3.2.7): ижил регистрт үргэлж ижил хариу. БҮХ нэр, хаяг зохиомол — бодит хүн биш.
// Тусгай регистрүүд (тестэд): тэг цифрүүд → ХУР-д байхгүй, есөн цифрүүд → ХУР унасан.
export const XYP_NOT_FOUND_DIGITS = ['00000000', '0000000'] as const;
export const XYP_UNAVAILABLE_DIGITS = ['99999999', '9999999'] as const;

const PATRONYMICS = ['Болд', 'Дорж', 'Ганбат', 'Батсайхан', 'Цэрэн', 'Эрдэнэ', 'Сүхбаатар', 'Пүрэв'];
const MALE = ['Бат-Эрдэнэ', 'Ганбаатар', 'Тэмүүлэн', 'Мөнхбат', 'Амарсанаа', 'Билгүүн'];
const FEMALE = ['Сарнай', 'Оюунчимэг', 'Номин', 'Энхжин', 'Цэцэгмаа', 'Мөнхзул'];
const COMPANIES = ['Тэнгэр', 'Алтан говь', 'Хөх тэнгэр', 'Монгол шуудан', 'Эрдэнэ трейд', 'Номин констракшн'];
const SECTORS = ['Худалдаа', 'Барилга', 'Хөдөө аж ахуй', 'Тээвэр', 'Үйлчилгээ', 'Үйлдвэрлэл'];
const ADDRESSES: CustomerAddress[] = [
  { province: 'Улаанбаатар', district: 'Баянзүрх', khoroo: '5-р хороо', detail: 'Хан-Уул хотхон, 12-р байр, 45 тоот' },
  { province: 'Улаанбаатар', district: 'Сүхбаатар', khoroo: '1-р хороо', detail: 'Бага тойруу, 8-р байр, 3 тоот' },
  { province: 'Улаанбаатар', district: 'Хан-Уул', khoroo: '11-р хороо', detail: 'Зайсан, 21-р байр, 17 тоот' },
  { province: 'Дархан-Уул', district: 'Дархан', khoroo: '4-р баг', detail: 'Нисэх, 3-р байр, 9 тоот' },
  { province: 'Орхон', district: 'Баян-Өндөр', khoroo: '2-р баг', detail: 'Гүнтэв, 14-р байр, 6 тоот' },
];
const MARITAL: MaritalStatus[] = ['MARRIED', 'SINGLE', 'MARRIED', 'DIVORCED', 'MARRIED', 'WIDOWED'];

/** FNV-1a: регистрээс тогтвортой тоо (Math.random/Date ашиглахгүй). */
export const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (const ch of s) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
};
export const pick = <T>(list: readonly T[], seed: number): T => list[seed % list.length]!;

/** Регистрийн 3–8-р цифр = ЖЖААОО (2000-оос хойш сар +20), сүүлийн цифр сондгой = эрэгтэй. Буруу огноо гарвал регистрээс тогтвортой огноо сонгоно. */
function birthOf(register: string, seed: number): { birthDate: string; gender: Gender } {
  const d = register.slice(2);
  const gender: Gender = Number(d.at(-1)) % 2 === 1 ? 'MALE' : 'FEMALE';
  const yy = Number(d.slice(0, 2));
  const mm = Number(d.slice(2, 4));
  const dd = Number(d.slice(4, 6));
  const year = (mm > 20 ? 2000 : 1900) + yy;
  const month = mm > 20 ? mm - 20 : mm;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const valid = new Date(`${iso}T00:00:00Z`);
  // `valid` нь Invalid Date байж болно (жишээ нь өдөр 56): toISOString() RangeError шидэх тул эхлээд шалгана.
  if (month >= 1 && month <= 12 && dd >= 1 && !Number.isNaN(valid.getTime()) && valid.toISOString().slice(0, 10) === iso && valid.getTime() < Date.now()) return { birthDate: iso, gender };
  return { birthDate: `${1970 + (seed % 35)}-${String(1 + (seed % 12)).padStart(2, '0')}-${String(1 + (seed % 28)).padStart(2, '0')}`, gender };
}

/** Бүх fixture-ийн `fetchedAt` — тогтмол (deterministic). */
export const XYP_FIXTURE_FETCHED_AT = '2026-01-01T00:00:00.000Z';

/** @param registerNo нормчилсон регистр. `null` = ХУР-д байхгүй; `undefined` = ХУР унасан. */
export function xypFixture(registerNo: string): XypCitizen | null | undefined {
  const type = customerTypeOfRegister(registerNo);
  if (!type) return null;
  const digits = type === 'INDIVIDUAL' ? registerNo.slice(2) : registerNo;
  if ((XYP_NOT_FOUND_DIGITS as readonly string[]).includes(digits)) return null;
  if ((XYP_UNAVAILABLE_DIGITS as readonly string[]).includes(digits)) return undefined;
  const seed = hash(registerNo);
  const address = pick(ADDRESSES, seed >>> 3);

  if (type === 'LEGAL_ENTITY') {
    return {
      registerNo, customerType: type, lastName: null, firstName: `${pick(COMPANIES, seed)} ХХК`, gender: null, birthDate: null,
      maritalStatus: null, familySize: null, activitySector: pick(SECTORS, seed >>> 5), address, fetchedAt: XYP_FIXTURE_FETCHED_AT,
    };
  }
  const { birthDate, gender } = birthOf(registerNo, seed);
  return {
    registerNo, customerType: type, lastName: pick(PATRONYMICS, seed >>> 7), firstName: pick(gender === 'MALE' ? MALE : FEMALE, seed >>> 11),
    gender, birthDate, maritalStatus: pick(MARITAL, seed >>> 13), familySize: 1 + ((seed >>> 17) % 6), activitySector: null, address, fetchedAt: XYP_FIXTURE_FETCHED_AT,
  };
}
