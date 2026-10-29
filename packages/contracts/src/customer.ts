import { z } from 'zod';
import { CustomerContactRelation, CustomerType, Gender, MaritalStatus } from './enums';

// Модуль 1 · Харилцагч, KYC (FR-2, FR-13.1). Origination `/api/customers` ба kyc `/api/xyp/citizen`-ийн гэрээ.
// Заавал талбарын дүрэм (FR-2.3) энд ГАНЦ газар — UI мөн адил схемээр шалгана, сервис дахин шалгана.

// ── Регистр, утас ──
const INVISIBLE = /[\s\u200B-\u200D\u2060\uFEFF]+/gu;
/** Том үсэг, хоосон зайгүй: "уб 90010112" → "УБ90010112". Хайлт (blind index) ба unique-ийн түлхүүр. */
export const normalizeRegisterNo = (s: string): string => s.normalize('NFC').replace(INVISIBLE, '').toLocaleUpperCase('mn');
const INDIVIDUAL_REGISTER = /^[А-ЯЁӨҮ]{2}\d{8}$/u; // иргэн: 2 кирилл үсэг + 8 цифр
const LEGAL_REGISTER = /^\d{7}$/; // байгууллага: 7 цифр
/** Регистрийн хэлбэрээс харилцагчийн төрлийг таана; танигдахгүй бол null. */
export const customerTypeOfRegister = (registerNo: string): CustomerType | null => {
  const r = normalizeRegisterNo(registerNo);
  return INDIVIDUAL_REGISTER.test(r) ? 'INDIVIDUAL' : LEGAL_REGISTER.test(r) ? 'LEGAL_ENTITY' : null;
};
export const isValidRegisterNo = (type: CustomerType, registerNo: string): boolean => customerTypeOfRegister(registerNo) === type;

/** Утас: 8 цифр. "+976 9911-2233", "976 99112233" → "99112233". */
export const normalizePhone = (s: string): string => {
  const d = s.replace(/[\s\-().]/g, '');
  return /^\+?976\d{8}$/.test(d) ? d.replace(/^\+?976/, '') : d;
};

// ── Бүрэлдэхүүн ──
const REQUIRED = 'Заавал бөглөнө';
const text = (max = 200) => z.string().trim().min(1, REQUIRED).max(max);
/** Хоосон мөр = "оруулаагүй": UI-ийн хоосон талбар заавал талбарын шалгалтыг давахгүй. */
const blankToUndef = (v: string) => (v === '' ? undefined : v);
const optText = (max = 200) => z.string().trim().max(max).transform(blankToUndef).optional();
const phoneRule = z.string().regex(/^\d{8}$/, 'Утас 8 оронтой тоо байх ёстой');
const Phone = z.string().trim().transform(normalizePhone).pipe(phoneRule);
const OptPhone = z.string().trim().transform(normalizePhone).transform(blankToUndef).pipe(phoneRule.optional()).optional();
const IsoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Огноо YYYY-MM-DD хэлбэртэй').refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '1900-01-01' && d.getTime() <= Date.now();
}, 'Огноо буруу эсвэл ирээдүйд байна');

/** 4 түвшин: аймаг/хот → сум/дүүрэг → баг/хороо → дэлгэрэнгүй (FR-2.3). */
export const CustomerAddress = z.object({ province: text(100), district: text(100), khoroo: text(100), detail: text(300) });
export type CustomerAddress = z.infer<typeof CustomerAddress>;

/** Хөдөлмөр эрхлэлт (FR-2.3): байгууллага, тушаал, хаяг, утас, сошиал. */
export const Employment = z.object({ organization: text(200), position: text(200), address: optText(300), phone: OptPhone, social: optText(300) });
export type Employment = z.infer<typeof Employment>;

/** Яаралтай холбоо барих хүн (FR-2.4). Регистр өгвөл хэлбэрийг шалгана (иргэн). */
export const CustomerContactInput = z.object({
  relation: z.enum(CustomerContactRelation),
  registerNo: z.string().trim().transform(normalizeRegisterNo).refine((v) => !v || INDIVIDUAL_REGISTER.test(v), 'Регистр УБ12345678 хэлбэртэй').optional(),
  lastName: optText(100), firstName: text(100), phone: Phone,
  employment: optText(200), homeAddress: optText(300),
});
export type CustomerContactInput = z.infer<typeof CustomerContactInput>;

const CustomerFieldsShape = z.object({
  customerType: z.enum(CustomerType),
  registerNo: z.string().trim().min(1, REQUIRED).transform(normalizeRegisterNo),
  lastName: optText(100), // овог
  firstName: text(100), // нэр; байгууллагад — нэр
  gender: z.enum(Gender).optional(),
  birthDate: IsoDate.optional(),
  phone: OptPhone,
  email: z.string().trim().max(200).transform(blankToUndef).pipe(z.string().email('И-мэйл буруу').optional()).optional(),
  photoFileId: z.string().trim().min(1).max(64).optional(), // dms.file.id
  familySize: z.number().int().min(1).max(30).optional(),
  activitySector: optText(200),
  maritalStatus: z.enum(MaritalStatus).optional(),
  segment: optText(100),
  education: optText(100),
  isRelatedParty: z.boolean().default(false), // KYC (FR-2.5): ББСБ-д хамааралтай этгээд
  isPep: z.boolean().default(false), // KYC (FR-2.5): улс төрд нөлөө бүхий этгээд
  officialAddress: CustomerAddress.optional(),
  residenceAddress: CustomerAddress.optional(),
  /** "Оршин суугаа хаяг = албан ёсны" чекбокс: true бол residenceAddress-ийг officialAddress-ээс хуулна. */
  residenceSameAsOfficial: z.boolean().default(false),
  employment: Employment.optional(),
  contacts: z.array(CustomerContactInput).max(10).default([]),
});
export const CUSTOMER_FIELD_KEYS = Object.keys(CustomerFieldsShape.shape) as (keyof typeof CustomerFieldsShape.shape)[];

const INDIVIDUAL_REQUIRED = ['lastName', 'gender', 'birthDate', 'phone', 'email', 'photoFileId', 'familySize', 'activitySector', 'maritalStatus', 'segment', 'education', 'officialAddress', 'employment'] as const;
const LEGAL_REQUIRED = ['phone', 'email', 'activitySector', 'segment', 'officialAddress'] as const;

/**
 * FR-2.3: бүрэн харилцагч. Заавал талбар дутуу бол issue бүр талбарын замтай (`path`) буцна → UI тухайн талбарыг улаанаар тэмдэглэнэ.
 * Байгууллагад хүйс/төрсөн огноо/ам бүл/гэрлэлт/боловсрол/ИҮ-ийн зураг/хөдөлмөр шаардахгүй.
 */
export const CustomerInput = CustomerFieldsShape.superRefine((v, ctx) => {
  const fail = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (!isValidRegisterNo(v.customerType, v.registerNo)) {
    fail('registerNo', v.customerType === 'INDIVIDUAL' ? 'Иргэний регистр 2 кирилл үсэг + 8 цифр (жишээ УБ90010112)' : 'Байгууллагын регистр 7 оронтой тоо');
  }
  for (const k of v.customerType === 'INDIVIDUAL' ? INDIVIDUAL_REQUIRED : LEGAL_REQUIRED) if (v[k] === undefined) fail(k, REQUIRED);
  if (!v.residenceSameAsOfficial && !v.residenceAddress) fail('residenceAddress', REQUIRED);
});
export type CustomerInput = z.infer<typeof CustomerInput>;
export type CustomerInputRaw = z.input<typeof CustomerInput>;

/** POST /customers: хэсэгчилсэн — `source=XYP` үед ХУР-ийн талбарыг сервер өөрөө нөхнө, дараа нь `CustomerInput`-аар бүрэн шалгана. */
export const CustomerSource = ['MANUAL', 'XYP'] as const;
export const CreateCustomerRequest = CustomerFieldsShape.partial().required({ registerNo: true }).extend({ source: z.enum(CustomerSource).default('MANUAL') });
export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequest>;

/** PUT /customers/:id: өгсөн талбарыг л солино (регистр, төрөл өөрчлөгдөхгүй). `contacts` өгвөл жагсаалтыг бүхэлд нь солино. */
export const UpdateCustomerRequest = CustomerFieldsShape.omit({ customerType: true, registerNo: true }).partial();
export type UpdateCustomerRequest = z.infer<typeof UpdateCustomerRequest>;

// ── Хар жагсаалт (BR-9: зөвхөн анхааруулга, хориг биш) ──
export const BlacklistWarning = z.object({
  code: z.literal('BLACKLISTED'), severity: z.literal('WARNING'),
  listType: z.string(), reasonCode: z.string(), reasonText: z.string().nullable(), registeredAt: z.string().datetime(),
});
export type BlacklistWarning = z.infer<typeof BlacklistWarning>;

// ── Хариу ──
export interface CustomerSummary {
  id: string; customerType: CustomerType; registerNoMasked: string; lastName: string | null; firstName: string;
  phone: string | null; isPep: boolean; isRelatedParty: boolean; blacklisted: boolean; createdAt: string;
}
export interface CustomerPage { items: CustomerSummary[]; total: number; page: number; pageSize: number }
export interface CustomerContactView extends Omit<CustomerContactInput, 'registerNo'> { id: string; registerNo: string | null }
export interface CustomerApplicationRef { id: string; appNo: string; status: string; role: string; amount: string | null; currency: string; contractNo: string | null; createdAt: string }
export interface CustomerView {
  id: string; customerType: CustomerType; registerNo: string; lastName: string | null; firstName: string;
  gender: Gender | null; birthDate: string | null; phone: string | null; email: string | null; photoFileId: string | null;
  familySize: number | null; activitySector: string | null; maritalStatus: MaritalStatus | null; segment: string | null; education: string | null;
  isRelatedParty: boolean; isPep: boolean; amlRiskScore: number | null;
  officialAddress: CustomerAddress | null; residenceAddress: CustomerAddress | null; residenceSameAsOfficial: boolean; employment: Employment | null;
  xypFetchedAt: string | null; branchId: string | null; createdAt: string; updatedAt: string;
  contacts: CustomerContactView[];
  warnings: BlacklistWarning[];
}
/** `GET /customers/:id` — харилцагчийн карт (FR-2.6): өмнөх зээлийн түүх нь хүсэлтийн харагдах хүрээгээр (NFR-3) шүүгдэнэ. */
export interface CustomerCard extends CustomerView { applications: CustomerApplicationRef[] }
/** `GET /customers/lookup?registerNo=` (FR-2.2): байгаа бол дахин бүртгэхгүй. */
export interface CustomerLookup { registerNo: string; customerType: CustomerType | null; exists: boolean; customer: CustomerSummary | null; warnings: BlacklistWarning[] }

// ── ХУР (kyc `POST /api/xyp/citizen`) ──
export const XypCitizenRequest = z.object({ registerNo: z.string().trim().min(1).transform(normalizeRegisterNo) });
export const XypCitizen = z.object({
  registerNo: z.string(), customerType: z.enum(CustomerType),
  lastName: z.string().nullable(), firstName: z.string(),
  gender: z.enum(Gender).nullable(), birthDate: z.string().nullable(),
  maritalStatus: z.enum(MaritalStatus).nullable(), familySize: z.number().int().nullable(),
  activitySector: z.string().nullable(), address: CustomerAddress.nullable(),
  fetchedAt: z.string().datetime(),
});
export type XypCitizen = z.infer<typeof XypCitizen>;

/** `POST /customers/xyp-fetch` — хадгалахгүй, зөвхөн маягтыг бөглөх өгөгдөл. `missing` = ХУР-аас дутсан заавал талбар ("зөвхөн дутууг асуух"). */
export interface XypFetchResult {
  registerNo: string; customerType: CustomerType;
  /** ХУР-аас татсан хугацаа. Харилцагч аль хэдийн бүртгэлтэй бол ХУР дуудахгүй (`existing` харна) → null. */
  fetchedAt: string | null;
  prefill: Partial<CustomerInputRaw>; prefilledFields: string[]; missing: string[];
  existing: CustomerSummary | null; warnings: BlacklistWarning[];
}
