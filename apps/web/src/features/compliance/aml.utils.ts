// Compliance · AML шалгалтын цэвэр туслахууд (I/O байхгүй). Дүрэм нь @los/contracts-оос — UI давхар тодорхойлохгүй.
import { AmlHitReviewRequest, type AmlHit } from '@los/contracts';
import { ApiError } from '../../lib/api';
import { t } from '../../lib/i18n';

export const AML_QUEUE_HREF = '/los/compliance/aml';
export const screeningHref = (id: string): string => `${AML_QUEUE_HREF}/${encodeURIComponent(id)}`;

/** Тайлбар заавал: `AmlHitReviewRequest.comment` (trim → 5–2000). Алдаа бол монгол текст, үгүй бол null. */
export function validateReviewReason(text: string): string | null {
  if (!text.trim()) return t('aml.review.reasonRequired');
  const parsed = AmlHitReviewRequest.shape.comment.safeParse(text);
  if (parsed.success) return null;
  return parsed.error.issues.some((i) => i.code === 'too_big') ? t('aml.review.reasonTooLong') : t('aml.review.reasonTooShort');
}

export interface ReviewConfirmCopy { decision: string; consequence: string }

/** F7-2: баталгаажуулах цонхны текст — сонгосон шийдвэрийн нэр ба үр дагавар (шийдвэр буцаагдахгүй тул заавал харуулна). */
export function reviewConfirmCopy(decision: AmlHitReviewRequest['decision']): ReviewConfirmCopy {
  return { decision: t(`aml.review.${decision}`), consequence: t(`aml.review.consequence.${decision}`) };
}

const SELF_REVIEW = /reviewer must differ/i;
const SUPERSEDED = /superseded/i;

/** kyc-ийн алдаа → монгол текст (§5: 403 дүр / 4 нүд, 409 давхар шийдвэр / хуучирсан шалгалт, 404). */
export function describeAmlError(e: unknown, fallbackKey: 'aml.error.GENERIC' | 'aml.error.LOAD'): string {
  if (!(e instanceof ApiError)) return t(fallbackKey);
  if (e.status === 403) return t(SELF_REVIEW.test(e.message) ? 'aml.error.SELF_REVIEW' : 'aml.error.FORBIDDEN');
  if (e.status === 409) return t(SUPERSEDED.test(e.message) ? 'aml.error.SUPERSEDED' : 'aml.error.ALREADY_REVIEWED');
  if (e.status === 404) return t('aml.error.NOT_FOUND');
  if (e.status === 400) return t('aml.error.VALIDATION');
  return t(fallbackKey);
}
export const describeAmlReviewError = (e: unknown): string => describeAmlError(e, 'aml.error.GENERIC');

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const DOB_EVIDENCE = ['MATCH', 'MISMATCH', 'UNKNOWN'];

/** Hit-ийн нотолгоо (жагсаалтын тал) — UI-д харуулах хэлбэрт. Регистр `matchedValue`-д аль хэдийн масклагдсан (kyc). */
export interface HitEvidence {
  name: string;
  dob: string | null;
  countries: string[];
  programme: string | null;
  listedOn: string | null;
  category: string | null;
  reasonCode: string | null;
}
export function hitEvidence(hit: AmlHit): HitEvidence {
  const d = hit.details;
  const dob = str(d['dateOfBirth']);
  return {
    name: str(d['matchedName']) ?? hit.entryName,
    dob: dob && DOB_EVIDENCE.includes(dob) ? t(`aml.dob.${dob}`) : null,
    countries: hit.list === 'FATF' ? [hit.entryRef] : strList(d['nationalities']),
    programme: str(d['programme']),
    listedOn: str(d['listedOn']),
    category: str(d['category']),
    reasonCode: str(d['reasonCode']),
  };
}

/** 4 нүдний зарчим (§5 `requireSeparateReviewer`): шалгалт эхлүүлсэн хэрэглэгч шийдвэрлэхгүй. Эцсийн шалгалт kyc-д. */
export const isOwnScreening = (screenedBy: string | null, userId: string | null | undefined): boolean => !!userId && screenedBy === userId;
