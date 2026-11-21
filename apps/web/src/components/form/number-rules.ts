import type { Rule } from 'antd/es/form';
import { t } from '../../lib/i18n';
import { formatNumberText } from './number-text';

// antd Form дүрмүүд — NumberTextInput-ийн утгыг шалгана: undefined = хоосон, NaN = "тоо биш текст", бусад нь тоо.
// Талбарын утгыг clamp хийхгүй: хүрээнээс гарсан/сөрөг/хэт нарийн утга бүр өөрийн тодорхой мессежтэй алдаа болно (F2-8, F2-17).
// `required` нь NaN-ийг хоосон гэж үзэхгүй (NaN ≠ undefined) тул "тоо биш" мессеж хэвээр гарна. Түүнийг Form.Item-д `validateFirst` өгч давхцуулахгүй.

/** Төгрөгийн дээд хязгаар = гэрээний `Money.max` (packages/contracts merchant.ts). Орлого, бүртгэлгүй зээл зэрэгт `max`-д өгнө. */
export const MAX_MONEY = 1_000_000_000_000;

export interface MoneyRuleOptions {
  /** Мессеж дэх талбарын нэр ("Зээлийн дүн 0-ээс их байх ёстой"). Анхдагч: "Дүн". */
  label?: string;
  /** true эсвэл өөрийн "Заавал бөглөнө" мессеж. */
  required?: boolean | string;
  /** 0-ээс их байх ёстой (0 нь алдаа). Үгүй бол 0 зөвшөөрнө. */
  positive?: boolean;
  max?: number;
  /** Анхдагч 2 (гэрээний `Money`: 0.01). Дугуйлахгүй — илүү орныг татгалзана. */
  maxDecimals?: number;
}

export interface PercentRuleOptions {
  label?: string;
  required?: boolean | string;
  min?: number;
  max?: number;
  maxDecimals?: number;
}

const decimalPlaces = (v: number): number => formatNumberText(v, false).split('.')[1]?.length ?? 0;
const isMissing = (v: unknown): boolean => v === undefined || v === null;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Мөнгөн утгын асуудал (мессеж) эсвэл null. Хоосон утга энд алдаа биш — `required` тусдаа. */
export function moneyProblem(v: unknown, o: MoneyRuleOptions): string | null {
  if (isMissing(v)) return null;
  if (!isNumber(v)) return t('input.money.notNumber');
  if (v < 0) return t('input.money.negative');
  const field = o.label ?? t('input.money.field');
  if (o.positive && v === 0) return t('input.money.positive', { field });
  if (o.max !== undefined && v > o.max) return t('input.money.max', { field, max: formatNumberText(o.max, true) });
  const maxDecimals = o.maxDecimals ?? 2;
  if (decimalPlaces(v) > maxDecimals) return t('input.number.decimals', { max: maxDecimals });
  return null;
}

/** Хувийн утгын (хувиар, 1.5 = 1.5%) асуудал эсвэл null. */
export function percentProblem(v: unknown, o: PercentRuleOptions): string | null {
  if (isMissing(v)) return null;
  if (!isNumber(v)) return t('input.percent.notNumber');
  const min = o.min ?? 0;
  const max = o.max ?? 100;
  if (v < min || v > max) return t('input.percent.range', { field: o.label ?? t('input.percent.field'), min, max });
  const maxDecimals = o.maxDecimals ?? 2;
  if (decimalPlaces(v) > maxDecimals) return t('input.number.decimals', { max: maxDecimals });
  return null;
}

const requiredRule = (required: boolean | string | undefined, fallback: string): Rule[] =>
  required ? [{ required: true, message: typeof required === 'string' ? required : fallback }] : [];

const validatorRule = (problem: (v: unknown) => string | null): Rule => ({
  validator: (_rule, value: unknown) => {
    const message = problem(value);
    return message ? Promise.reject(new Error(message)) : Promise.resolve();
  },
});

/** `<Form.Item rules={moneyRules({ positive: true })}>` + `<MoneyInput />`. */
export const moneyRules = (o: MoneyRuleOptions = {}): Rule[] => [...requiredRule(o.required, t('input.money.required')), validatorRule((v) => moneyProblem(v, o))];

/** `<Form.Item rules={percentRules({ label, max: 100 })}>` + `<PercentInput />` (форм дэх утга хувиар). */
export const percentRules = (o: PercentRuleOptions = {}): Rule[] => [...requiredRule(o.required, t('input.percent.required')), validatorRule((v) => percentProblem(v, o))];
