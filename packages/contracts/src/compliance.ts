import { z } from 'zod';
import { BorrowerRole } from './enums';

// Compliance & AML — enum, DTO (sync REST) ба хар жагсаалтын гэрээ.
// Эзэмшигч: kyc (screening), origination (blacklist CRUD). Event схем нь events.ts-д (CLAUDE.md §3.2.5).

// ── Enum ────────────────────────────────────────────────────────────────────
export const ScreeningList = ['UN_SC', 'FATF', 'INTERNAL_BLACKLIST'] as const;
export type ScreeningList = typeof ScreeningList[number];
export const AmlSubjectType = ['INDIVIDUAL', 'LEGAL_ENTITY'] as const;
export type AmlSubjectType = typeof AmlSubjectType[number];
export const ScreeningTrigger = ['APPLICATION', 'PERIODIC', 'LIST_UPDATE', 'MANUAL'] as const;
export type ScreeningTrigger = typeof ScreeningTrigger[number];
export const HitMatchType = ['REGISTER_EXACT', 'NAME_EXACT', 'NAME_FUZZY', 'COUNTRY'] as const;
export type HitMatchType = typeof HitMatchType[number];
export const HitSeverity = ['WARNING', 'BLOCKING'] as const;
export type HitSeverity = typeof HitSeverity[number];
export const HitStatus = ['OPEN', 'CONFIRMED', 'FALSE_POSITIVE'] as const;
export type HitStatus = typeof HitStatus[number];
export const ScreeningStatus = ['CLEAR', 'WARNING', 'REVIEW_REQUIRED', 'CONFIRMED_MATCH', 'CLEARED_AFTER_REVIEW'] as const;
export type ScreeningStatus = typeof ScreeningStatus[number];
export const AmlRiskLevel = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type AmlRiskLevel = typeof AmlRiskLevel[number];
export const FatfCategory = ['CALL_FOR_ACTION', 'INCREASED_MONITORING'] as const;
export type FatfCategory = typeof FatfCategory[number];

// ── Бодлого (BR утгууд setting-ээс; анхдагч нь docs/05-compliance-aml.md §4) ──────
const unit = z.number().min(0).max(1);
export const AmlRiskWeights = z.object({
  pep: z.number().min(0).default(25),
  relatedParty: z.number().min(0).default(10),
  fatfIncreasedMonitoring: z.number().min(0).default(15),
  fatfCallForAction: z.number().min(0).default(40),
  internalBlacklist: z.number().min(0).default(20),
  sanctionsPossible: z.number().min(0).default(60),
  sanctionsConfirmed: z.number().min(0).default(100),
});
export const AmlPolicy = z.object({
  /** Нэрийн ижилсэл энэ босгоос дээш бол hit үүснэ. */
  reviewThreshold: unit.default(0.88),
  /** Төрсөн он таарахгүй үед энэ босгоос дээш байж л hit үүснэ. */
  strongThreshold: unit.default(0.95),
  /** UN хориг жагсаалтын тохирол шийдвэрлэгдтэл хүсэлтийг хаах эсэх (BR-9 хамаарахгүй — DECISIONS). */
  blockOnSanctionsHit: z.boolean().default(true),
  blockOnFatfCallForAction: z.boolean().default(false),
  /** BR-9: дотоод хар жагсаалт зөвхөн анхааруулга. */
  blockOnInternalBlacklist: z.boolean().default(false),
  /** Шалгалтыг эхлүүлсэн хүн өөрийн шалгалтын hit-ийг шийдвэрлэж болохгүй (4 нүдний зарчим). */
  requireSeparateReviewer: z.boolean().default(true),
  /** Жагсаалтын snapshot хэдэн цаг хүртэл (татаж чадахгүй үед) хуучин хэвээр ашиглахыг зөвшөөрөх. */
  maxStaleListHours: z.number().positive().default(72),
  risk: z.object({
    weights: AmlRiskWeights.default({}),
    mediumFrom: z.number().min(0).max(100).default(30),
    highFrom: z.number().min(0).max(100).default(60),
  }).default({}),
}).superRefine((p, ctx) => {
  // strong < review бол төрсөн он зөрсөн / LOW_ALIAS нэрэнд тавих "хатуу" босго энгийн босгоосоо бага болж, дүрэм урвуу ажиллана.
  if (p.strongThreshold < p.reviewThreshold) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['strongThreshold'], message: 'strongThreshold must be >= reviewThreshold' });
  }
  if (p.risk.mediumFrom >= p.risk.highFrom) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['risk', 'mediumFrom'], message: 'risk.mediumFrom must be < risk.highFrom' });
  }
});
export type AmlPolicy = z.infer<typeof AmlPolicy>;
export const DEFAULT_AML_POLICY: AmlPolicy = AmlPolicy.parse({});

// ── Screening DTO ───────────────────────────────────────────────────────────
const countryCode = z.string().length(2).regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase());

// Регистр: @los/database normalizeRegisterNo-той ижил дүрмээр (Cf устгах → NFKC → том үсэг → NFKC → үсэг/аравтын цифр биш бүгдийг устгах)
// НОРМЧИЛСОН УРТЫГ л тоолно (look-alike mapping 1:1 тул уртад нөлөөгүй). contracts нь @los/database-г импортлохгүй тул давхар;
// kyc дээрх parity тест хоёр хэрэгжилтийг тулгана.
export const REGISTER_NO_MAX_LENGTH = 32;
const REGISTER_NO_FORMAT_CHARS = /\p{Cf}/gu;
const REGISTER_NO_NOT_ALNUM = /[^\p{L}\p{Nd}]|\p{Lm}/gu;
export function normalizedRegisterNoLength(raw: string): number {
  const stripped = raw.replace(REGISTER_NO_FORMAT_CHARS, '').normalize('NFKC').toUpperCase().normalize('NFKC').replace(REGISTER_NO_NOT_ALNUM, '');
  return [...stripped].length;
}
/** Нормчилсны дараа дор хаяж 1 үсэг/цифртэй, ≤ 32 тэмдэгт эсэх. Origination хар жагсаалтын schema ч үүнийг ашиглаж болно. */
export const isUsableRegisterNo = (raw: string): boolean => {
  const length = normalizedRegisterNoLength(raw);
  return length >= 1 && length <= REGISTER_NO_MAX_LENGTH;
};

// Нэрийн токен (DoS хязгаар): matching/normalize.ts-ийн токенчлолтой ижил хуваалт (NFKC → зай, зураас, _ . , / \ -аар таслах).
// Үсэг/цифргүй хэсгийг тоолохгүй. NFKC эхэлж орох ёстой (жнь U+FDFA нэг тэмдэгт 4 үг болж задарна).
// 12 үг: араб "bin/al" угсаа залгамжлалтай нэр (Sheikh Hamad bin Khalifa bin Hamad bin Abdullah bin Jassim al-Thani = 12) ба
// испани/герман овог-угтвартай нэр багтана. Нийт 48 нь CPU-г хязгаарлана (screening-engine.test.ts-ийн CPU тест хамгийн их субъектээр).
export const MAX_NAME_TOKENS = 12;
export const MAX_SUBJECT_NAME_TOKENS = 48;
const NAME_TOKEN_SEPARATORS = /[\s\p{Pd}_.,/\\]+/u;
export function nameTokenCount(name: string): number {
  return name.normalize('NFKC').split(NAME_TOKEN_SEPARATORS).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

export const AmlSubject = z.object({
  subjectType: z.enum(AmlSubjectType),
  /** Регистр (хувь хүн: 2 кирилл үсэг + 8 цифр; ААН: 7 цифр). Нормчилсны дараа 1..32 үсэг/цифр. Лог-д бичихгүй. */
  registerNo: z.string().trim().min(1).max(32).refine(isUsableRegisterNo, {
    message: 'registerNo must contain at least one letter or digit and be at most 32 characters after normalisation',
  }),
  lastName: z.string().trim().max(120).optional(),
  /** ААН-ийн хувьд байгууллагын нэр. */
  firstName: z.string().trim().min(1).max(200),
  /** Бусад нэр: латин бичиглэл, хуучин нэр, ургийн овог гэх мэт. */
  aliases: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  /** YYYY-MM-DD */
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Иргэншил / оршин суугаа / бүртгэлтэй улс (ISO 3166-1 alpha-2). Хоосон бол ['MN']. */
  countries: z.array(countryCode).max(10).default([]),
  isPep: z.boolean().default(false),
  isRelatedParty: z.boolean().default(false),
}).superRefine((s, ctx) => {
  // DoS: нэр бүр ≤ 12 токен, нийт ≤ 48 токен (Jaro-Winkler нь токен хос бүрт ажиллана).
  let total = 0;
  const check = (name: string | undefined, path: (string | number)[]) => {
    const count = name ? nameTokenCount(name) : 0;
    total += count;
    if (count > MAX_NAME_TOKENS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `name must have at most ${MAX_NAME_TOKENS} words` });
    }
  };
  check(s.lastName, ['lastName']);
  check(s.firstName, ['firstName']);
  s.aliases.forEach((alias, i) => check(alias, ['aliases', i]));
  if (total > MAX_SUBJECT_NAME_TOKENS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: `subject names must have at most ${MAX_SUBJECT_NAME_TOKENS} words in total` });
  }
});
export type AmlSubject = z.infer<typeof AmlSubject>;

/**
 * Шалгалтын хүсэлтийн id талбарын дээд урт. orgId / customerId нь индекстэй багана (aml_screening(org_id, customer_id, screened_at)) тул
 * хязгааргүй байвал Postgres btree-ийн мөрийн хэмжээнээс хэтэрч (54000) шалгалт бүтэн бодогдсоны дараа 500 өгдөг.
 */
export const AML_ID_MAX_LENGTH = 128;
export const AmlScreenRequest = z.object({
  orgId: z.string().min(1).max(AML_ID_MAX_LENGTH),
  customerId: z.string().min(1).max(AML_ID_MAX_LENGTH),
  applicationId: z.string().max(AML_ID_MAX_LENGTH).nullable().optional(),
  borrowerRole: z.enum(BorrowerRole).optional(),
  trigger: z.enum(ScreeningTrigger).default('APPLICATION'),
  subject: AmlSubject,
  // Шалгалт ҮРГЭЛЖ UN_SC, FATF, INTERNAL_BLACKLIST гурвуулаар хийгдэнэ (жагсаалтын дэд олонлог сонгох боломжгүй).
  // Клиентээс ирсэн нэмэлт `lists` талбарыг zod хаяна (strip).
});
export type AmlScreenRequest = z.infer<typeof AmlScreenRequest>;

export const AmlHit = z.object({
  id: z.string(),
  list: z.enum(ScreeningList),
  matchType: z.enum(HitMatchType),
  /** 0..1. REGISTER_EXACT / COUNTRY = 1. */
  score: z.number().min(0).max(1),
  severity: z.enum(HitSeverity),
  status: z.enum(HitStatus),
  /** Жагсаалтын бүртгэлийн дугаар: UN refId, FATF улсын код, дотоод хар жагсаалтын id. */
  entryRef: z.string(),
  entryName: z.string(),
  matchedValue: z.string().nullable(),
  /** Нотолгоо: хөтөлбөр, ангилал, төрсөн он тулгалт, шалтгааны код… (регистр агуулахгүй) */
  details: z.record(z.unknown()),
  listVersion: z.string(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  reviewComment: z.string().nullable(),
});
export type AmlHit = z.infer<typeof AmlHit>;

export const AmlRiskFactor = z.object({ code: z.string(), weight: z.number(), detail: z.string().optional() });
export type AmlRiskFactor = z.infer<typeof AmlRiskFactor>;
export const AmlScreeningResult = z.object({
  id: z.string(),
  orgId: z.string(),
  customerId: z.string(),
  applicationId: z.string().nullable(),
  trigger: z.enum(ScreeningTrigger),
  status: z.enum(ScreeningStatus),
  /** true бол шийдвэрлэгдтэл хүсэлтийг үргэлжлүүлэхгүй (origination хаалт). */
  blocking: z.boolean(),
  riskScore: z.number().min(0).max(100),
  riskLevel: z.enum(AmlRiskLevel),
  riskFactors: z.array(AmlRiskFactor),
  subjectName: z.string(),
  registerNoMasked: z.string(),
  hits: z.array(AmlHit),
  /** Шалгасан жагсаалт бүрийн хувилбар (snapshot version). */
  listVersions: z.record(z.string()),
  screenedAt: z.string().datetime(),
  screenedBy: z.string().nullable(),
});
export type AmlScreeningResult = z.infer<typeof AmlScreeningResult>;

export const AmlHitReviewRequest = z.object({
  decision: z.enum(['CONFIRMED', 'FALSE_POSITIVE']),
  /** Тайлбар заавал (аудит). */
  comment: z.string().trim().min(5).max(2000),
});
export type AmlHitReviewRequest = z.infer<typeof AmlHitReviewRequest>;

export const AmlListStatus = z.object({
  list: z.enum(ScreeningList),
  version: z.string().nullable(),
  publishedAt: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  entryCount: z.number(),
  stale: z.boolean(),
  lastError: z.string().nullable(),
});
export type AmlListStatus = z.infer<typeof AmlListStatus>;

// ── Дотоод хар жагсаалт (origination.blacklist, FR-13.1) ───────────────────────
/** BR-9: бүх шалтгаанд зөвхөн анхааруулга. list_type, reason_code = богино код (docs/03 §Хар жагсаалт). */
const code = z.string().trim().min(1).max(32).regex(/^[A-Z0-9_]+$/);
export const BlacklistEntryInput = z.object({
  registerNo: z.string().trim().min(1).max(32),
  customerType: z.enum(AmlSubjectType),
  name: z.string().trim().min(1).max(200),
  listType: code.default('DELINQUENT'),
  reasonCode: code,
  reasonText: z.string().trim().max(2000).optional(),
});
export type BlacklistEntryInput = z.infer<typeof BlacklistEntryInput>;
// reasonText: null эсвэл '' = тайлбарыг арилгана (GET-ийн хариуг буцаан PATCH хийхэд null ирдэг тул nullable).
export const BlacklistEntryUpdate = BlacklistEntryInput.partial().extend({
  reasonText: z.string().trim().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type BlacklistEntryUpdate = z.infer<typeof BlacklistEntryUpdate>;
export const BlacklistEntry = BlacklistEntryInput.extend({
  id: z.string(),
  orgId: z.string(),
  reasonText: z.string().nullable(),
  isActive: z.boolean(),
  registeredBy: z.string(),
  registeredAt: z.string().datetime(),
});
export type BlacklistEntry = z.infer<typeof BlacklistEntry>;
export const BlacklistImportRow = BlacklistEntryInput;
export const BlacklistImportResult = z.object({
  created: z.number(), updated: z.number(), skipped: z.number(),
  errors: z.array(z.object({ row: z.number(), message: z.string() })),
});
export type BlacklistImportResult = z.infer<typeof BlacklistImportResult>;
