import type { Rule } from 'antd/es/form';
import { formatNumberText } from '../../components/form/number-text';
import { t } from '../../lib/i18n';

// Нэгжгүй тоо (хугацаа/сар, оноо, ӨТЧХ коэффициент) — `PlainNumberInput`-ийн утгыг шалгана: undefined = хоосон, NaN = "тоо биш текст".
// Мөнгө/хувийн дүрэм `components/form/number-rules.ts`-д; энд зөвхөн тэдгээрт багтдаггүй нэгжгүй тоо. Утгыг clamp/дугуйлахгүй, дүрэм бүр өөрийн мессежтэй (F9-2).

export interface PlainNumberOptions {
  /** Мессеж дэх талбарын нэр ("Доод хугацаа 1–600 хооронд байх ёстой"). */
  label: string;
  required?: boolean;
  min?: number;
  max?: number;
  /** Бүхэл тоо байх ёстой (бутархайг дугуйлахгүй, татгалзана). */
  integer?: boolean;
  /** Бүхэл биш үед бутархай оронгийн дээд хэмжээ. Анхдагч 4 (гэрээний `dec4`). */
  maxDecimals?: number;
}

const decimalPlaces = (v: number): number => formatNumberText(v, false).split('.')[1]?.length ?? 0;

/** Асуудлын мессеж эсвэл null. Хоосон утга энд алдаа биш — `required` тусдаа. */
export function plainNumberProblem(v: unknown, o: PlainNumberOptions): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return t('admin.num.not_number');
  const belowMin = o.min !== undefined && v < o.min;
  const aboveMax = o.max !== undefined && v > o.max;
  if (belowMin || aboveMax) return t('admin.num.range', { field: o.label, min: o.min ?? '', max: o.max ?? '' });
  if (o.integer) return Number.isInteger(v) ? null : t('admin.num.whole', { field: o.label });
  const maxDecimals = o.maxDecimals ?? 4;
  return decimalPlaces(v) > maxDecimals ? t('input.number.decimals', { max: maxDecimals }) : null;
}

/** `<Form.Item rules={plainNumberRules({ label, min: 1, max: 600, integer: true })}>` + `<PlainNumberInput />`. */
export const plainNumberRules = (o: PlainNumberOptions): Rule[] => [
  ...(o.required ? [{ required: true, message: t('admin.num.required', { field: o.label }) }] : []),
  { validator: (_rule, value: unknown) => {
    const message = plainNumberProblem(value, o);
    return message ? Promise.reject(new Error(message)) : Promise.resolve();
  } },
];
