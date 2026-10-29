import {
  COLLATERAL_DESCRIPTION_SCHEMAS, CreateCollateralRequest, UpdateCollateralRequest,
  type AssetType, type CollateralSource, type CollateralView,
} from '@los/contracts';
import type { ZodIssue } from 'zod';
import { t } from '../../lib/i18n';
import { isMongolianText } from '../documents/shared/api-error';
import { FIELD_SPECS, formNamePath, getPath, setPath } from './collateral.fields';

// Форм ↔ хүсэлт хөрвүүлэлт ба `@los/contracts`-ийн zod схемээр шалгалт (FR-6.1). Цэвэр функцүүд — React, antd-ээс хамааралгүй.
// Бүх шалгалтын дүрэм схемд (CreateCollateralRequest / COLLATERAL_DESCRIPTION_SCHEMAS); энд зөвхөн алдааг монгол мессеж болгож, талбарт буулгана.

export interface CollateralFormValues {
  assetType?: AssetType;
  ownerCustomerId?: string;
  description?: Record<string, unknown>;
  registryNo?: string | null;
  registryDate?: string | null;
  insuranceExpiresAt?: string | null;
  note?: string | null;
}

/** antd `form.setFields` хэлбэр. */
export interface FieldError {
  name: string[];
  message: string;
}

export type BuildResult<T> = { ok: true; body: T } | { ok: false; errors: FieldError[] };

// ── zod алдаа → монгол мессеж ─────────────────────────────────────────────────────────────
export function zodIssueMessage(issue: ZodIssue): string {
  // Гэрээнд монголоор бичсэн мессеж (огнооны хэлбэр, үл хөдлөхийн дугаар) хэвээр
  if (isMongolianText(issue.message)) return issue.message;
  const field = String(issue.path[issue.path.length - 1] ?? '');
  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined' || issue.received === 'null' ? t('collateral.validation.required') : t('collateral.validation.invalid');
    case 'too_small': {
      const min = Number(issue.minimum);
      if (issue.type === 'string') return min <= 1 ? t('collateral.validation.required') : t('collateral.validation.minLength', { min });
      return issue.inclusive ? t('collateral.validation.min', { min }) : t('collateral.validation.greaterThan', { min });
    }
    case 'too_big': {
      const max = Number(issue.maximum);
      return issue.type === 'string' ? t('collateral.validation.maxLength', { max }) : t('collateral.validation.max', { max });
    }
    case 'invalid_string':
      if (field === 'plateNo') return t('collateral.validation.plateNo');
      return issue.validation === 'uuid' ? t('collateral.validation.required') : t('collateral.validation.invalid');
    case 'invalid_enum_value':
    case 'invalid_union_discriminator':
      return t('collateral.validation.choose');
    default:
      return t('collateral.validation.invalid');
  }
}

export const mapZodIssues = (issues: readonly ZodIssue[], prefix: string[] = []): FieldError[] =>
  issues.map((issue) => ({ name: [...prefix, ...issue.path.map(String)], message: zodIssueMessage(issue) }));

// ── цэвэрлэгээ ────────────────────────────────────────────────────────────────────────────
const cleanScalar = (v: unknown): string | number | undefined => {
  if (typeof v === 'string') return v.trim() === '' ? undefined : v.trim();
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  return undefined;
};

/** Зөвхөн тухайн төрлийн талбарууд, хоосон/NaN-гүй, мөр trim хийсэн. Үл мэдэгдэх түлхүүр хасагдана. */
export function cleanDescription(assetType: AssetType, raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of FIELD_SPECS[assetType]) {
    const value = cleanScalar(getPath(raw, spec.name));
    if (value !== undefined) setPath(out, spec.name, value);
  }
  return out;
}

/** Шинэ барьцааны форм дээрх анхдагч утгууд (схемийн `default`-той нийцнэ). */
export function defaultDescription(assetType: AssetType): Record<string, unknown> {
  switch (assetType) {
    case 'APARTMENT':
    case 'HOUSE':
      return { purpose: 'RESIDENTIAL' };
    case 'LAND':
      return { landUse: 'RESIDENTIAL' };
    case 'LIVESTOCK':
      return { ageGroup: 'ADULT' };
    default:
      return {};
  }
}

const optionalText = (v: string | null | undefined): string | undefined => cleanScalar(v ?? undefined) as string | undefined;

// ── үүсгэх ────────────────────────────────────────────────────────────────────────────────
export interface CreateMeta {
  source: CollateralSource;
  xypRef?: string | null;
}

export function buildCreateRequest(values: CollateralFormValues, meta: CreateMeta): BuildResult<CreateCollateralRequest> {
  const errors: FieldError[] = [];
  if (!values.assetType) errors.push({ name: ['assetType'], message: t('collateral.validation.choose') });
  if (!values.ownerCustomerId) errors.push({ name: ['ownerCustomerId'], message: t('collateral.validation.owner') });
  if (!values.assetType) return { ok: false, errors };

  const candidate = {
    assetType: values.assetType,
    ownerCustomerId: values.ownerCustomerId,
    source: meta.source,
    ...(meta.source === 'XYP' && meta.xypRef ? { xypRef: meta.xypRef } : {}),
    registryNo: optionalText(values.registryNo),
    registryDate: optionalText(values.registryDate),
    insuranceExpiresAt: optionalText(values.insuranceExpiresAt),
    note: optionalText(values.note),
    description: cleanDescription(values.assetType, values.description),
  };
  const parsed = CreateCollateralRequest.safeParse(candidate);
  if (!parsed.success) {
    const fromSchema = mapZodIssues(parsed.error.issues).filter((e) => !(e.name[0] === 'ownerCustomerId' && !values.ownerCustomerId));
    return { ok: false, errors: [...errors, ...fromSchema] };
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, body: parsed.data };
}

// ── засах ─────────────────────────────────────────────────────────────────────────────────
export function formValuesOf(c: Pick<CollateralView, 'assetType' | 'description' | 'owner' | 'registryNo' | 'registryDate' | 'insuranceExpiresAt' | 'note'>): CollateralFormValues {
  return {
    assetType: c.assetType,
    ownerCustomerId: c.owner.customerId ?? undefined,
    description: cleanDescription(c.assetType, c.description),
    registryNo: c.registryNo,
    registryDate: c.registryDate,
    insuranceExpiresAt: c.insuranceExpiresAt,
    note: c.note,
  };
}

/** Түлхүүрээр эрэмбэлсэн JSON — гүн харьцуулалтад. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * PATCH body: зөвхөн өөрчлөгдсөн талбар (өмчлөгч / тодорхойлолт өөрчлөгдвөл сервер өмчлөл, ачаалал, үнэлгээг хүчингүй болгодог тул
 * хөндөөгүй зүйлийг илгээхгүй). `description` нь бүтнээрээ. Өөрчлөлт байхгүй бол `body = null`.
 */
export function buildUpdateRequest(original: CollateralView, values: CollateralFormValues): BuildResult<UpdateCollateralRequest | null> {
  const schema = COLLATERAL_DESCRIPTION_SCHEMAS[original.assetType];
  const cleaned = cleanDescription(original.assetType, values.description);
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) return { ok: false, errors: mapZodIssues(parsed.error.issues, ['description']) };
  const originalParsed = schema.safeParse(cleanDescription(original.assetType, original.description));
  const originalNormalized = originalParsed.success ? originalParsed.data : cleanDescription(original.assetType, original.description);

  const body: Record<string, unknown> = {};
  if (values.ownerCustomerId && values.ownerCustomerId !== original.owner.customerId) body.ownerCustomerId = values.ownerCustomerId;
  if (stableStringify(parsed.data) !== stableStringify(originalNormalized)) body.description = parsed.data;
  const nullable = (next: string | null | undefined, prev: string | null): string | null | undefined => {
    const n = optionalText(next) ?? null;
    return n === prev ? undefined : n;
  };
  const registryNo = nullable(values.registryNo, original.registryNo);
  const registryDate = nullable(values.registryDate, original.registryDate);
  const insuranceExpiresAt = nullable(values.insuranceExpiresAt, original.insuranceExpiresAt);
  const note = nullable(values.note, original.note);
  if (registryNo !== undefined) body.registryNo = registryNo;
  if (registryDate !== undefined) body.registryDate = registryDate;
  if (insuranceExpiresAt !== undefined) body.insuranceExpiresAt = insuranceExpiresAt;
  if (note !== undefined) body.note = note;
  if (Object.keys(body).length === 0) return { ok: true, body: null };

  const checked = UpdateCollateralRequest.safeParse(body);
  if (!checked.success) return { ok: false, errors: mapZodIssues(checked.error.issues) };
  return { ok: true, body: checked.data };
}

/** Форм дээрх талбарын antd name (тест, setFields-д). */
export const descriptionFieldName = formNamePath;
