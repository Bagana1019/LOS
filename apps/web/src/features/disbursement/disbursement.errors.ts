import { t } from '../../lib/i18n';
import { describeError } from '../borrowers/borrowers.utils';

// F5-4: серверийн (англи zod) алдааг олголтын маягтад монгол, талбарын label-тай мессеж болгоно. Зөвхөн энэ feature-д.
// Бодит body: `{ code:'VALIDATION_FAILED', details:[{ path:'accountNo', message:'String must contain at least 4 character(s)' }] }`.

export type DisbursementField = 'disburseAmount' | 'disburseDate' | 'bankCode' | 'accountNo' | 'holderName' | 'accountOwnerType';
const LABEL_KEY: Record<DisbursementField, string> = {
  disburseAmount: 'disb.field.amount', disburseDate: 'disb.field.date', bankCode: 'disb.field.bank',
  accountNo: 'disb.field.accountNo', holderName: 'disb.field.holder', accountOwnerType: 'disb.field.owner',
};
const FIELDS = Object.keys(LABEL_KEY) as DisbursementField[];
/** Талбарт хамаарах бизнес алдааны код (серверийн мессеж монгол). */
const CODE_FIELD: Record<string, DisbursementField> = { DISBURSE_EXCEEDS_APPROVED: 'disburseAmount' };

export interface DisbursementFieldError { name: DisbursementField; message: string }
export interface DescribedDisbursementError {
  /** Маягтын товчны дэргэд харуулах нэг монгол өгүүлбэр. */
  message: string;
  /** Талбар бүрийн доор харуулах мессеж (хоосон байж болно). */
  fields: DisbursementFieldError[];
}

interface Parts { status: number | null; code: string | null; message: string; issues: unknown[] }
interface RawIssue { path?: unknown; message?: unknown }

const RE_MIN = /at least (\d+) character/;
const RE_MAX = /at most (\d+) character/;
const RE_NOT_POSITIVE = /greater than 0|must be positive/i;
const RE_CYRILLIC = /\p{Script=Cyrillic}/u;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function partsOf(error: unknown): Parts {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { status?: unknown; code?: unknown; message?: unknown; issues?: unknown };
  return { status: typeof e.status === 'number' ? e.status : null, code: str(e.code) || null, message: str(e.message), issues: Array.isArray(e.issues) ? e.issues : [] };
}

/** `path` нь "accountNo" эсвэл "holderName.0" (gateway/origination), эсвэл массив; зөвхөн эхний сегмент. */
function fieldOf(path: unknown): DisbursementField | null {
  const head = Array.isArray(path) ? path[0] : typeof path === 'string' ? path.split(/[.[]/)[0] : undefined;
  return FIELDS.find((f) => f === head) ?? null;
}

function issueMessage(field: DisbursementField, text: string): string {
  const label = t(LABEL_KEY[field]);
  const min = RE_MIN.exec(text)?.[1];
  const max = RE_MAX.exec(text)?.[1];
  if (text === 'Required' || min === '1') return t('disb.err.required', { field: label });
  if (min) return t('disb.err.tooShort', { field: label, min });
  if (max) return t('disb.err.tooLong', { field: label, max });
  if (field === 'disburseAmount' && RE_NOT_POSITIVE.test(text)) return t('disb.err.amount');
  return t('disb.err.invalid', { field: label });
}

const rejected = (): DescribedDisbursementError => ({ message: t('disb.err.rejected'), fields: [] });

/** Талбар бүрт эхний алдаа л үлдэнэ (дараалал хадгална). */
function fromIssues(p: Parts): DescribedDisbursementError | null {
  if (p.issues.length === 0) return null;
  const mapped = p.issues.flatMap((raw) => {
    const issue = (typeof raw === 'object' && raw !== null ? raw : {}) as RawIssue;
    const name = fieldOf(issue.path);
    return name ? [{ name, message: issueMessage(name, str(issue.message)) }] : [];
  });
  const fields = mapped.filter((f, i) => mapped.findIndex((g) => g.name === f.name) === i);
  return fields.length > 0 ? { message: t('disb.err.formInvalid'), fields } : rejected();
}

function fromCode(p: Parts): DescribedDisbursementError | null {
  const name = p.code ? CODE_FIELD[p.code] : undefined;
  if (!name) return null;
  const message = RE_CYRILLIC.test(p.message) ? p.message : t('disb.err.invalid', { field: t(LABEL_KEY[name]) });
  return { message: t('disb.err.formInvalid'), fields: [{ name, message }] };
}

/** Танигдаагүй 4xx: сервер монгол мессеж өгсөн бол тэр хэвээр, англи бол ерөнхий монгол текст. 401/403 нь хуваалцсан мессежээр. */
function fromUnmapped4xx(p: Parts): DescribedDisbursementError | null {
  if (p.status === null || p.status < 400 || p.status >= 500 || p.status === 401 || p.status === 403) return null;
  return RE_CYRILLIC.test(p.message) ? { message: p.message, fields: [] } : rejected();
}

export function describeDisbursementError(error: unknown): DescribedDisbursementError {
  const p = partsOf(error);
  return fromIssues(p) ?? fromCode(p) ?? fromUnmapped4xx(p) ?? { message: describeError(error, t).message, fields: [] };
}
