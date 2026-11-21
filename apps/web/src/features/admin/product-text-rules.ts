import type { Rule } from 'antd/es/form';
import { ProductCode, ProductEditable, ProductType } from '@los/contracts';
import { t } from '../../lib/i18n';

// F9-3: бүтээгдэхүүний код / төрөл / нэр талбарын шалгалт. Эх сурвалж нь серверийн `@los/contracts` (ProductCode, ProductType, ProductEditable.name) —
// тэр schema-г өөрийг нь ажиллуулж, мессежийг талбар бүрт Монголоор жишээтэй болгоно ("UPPER_SNAKE_CASE", "String must contain…" биш).
// Тоон талбарын (дүн, хугацаа, хүү) дүрэм `plain-number-rules.ts` / `components/form`-д.

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Код: форм `formToProduct`-д trim хийж илгээдэг тул энд ч trim хийж шалгана. */
export function productCodeProblem(value: unknown): string | null {
  const text = asText(value).trim();
  if (!text) return t('admin.products.error.code_required');
  return ProductCode.safeParse(text).success ? null : t('admin.products.error.code_format');
}

export function productTypeProblem(value: unknown): string | null {
  const text = asText(value).trim();
  if (!text) return t('admin.products.error.type_required');
  return ProductType.safeParse(text).success ? null : t('admin.products.error.type_format');
}

export function productNameProblem(value: unknown): string | null {
  const text = asText(value);
  if (!text.trim()) return t('admin.products.error.name_required');
  return ProductEditable.shape.name.safeParse(text).success ? null : t('admin.products.error.name_invalid');
}

/** `required` нь улаан од (*) харуулна; `whitespace` нь зөвхөн зайг хоосонд тооцно; validator нь формат/хэмжээг шалгана. */
const textRules = (requiredMessage: string, check: (value: unknown) => string | null): Rule[] => [
  { required: true, whitespace: true, message: requiredMessage },
  { validator: (_rule, value: unknown) => {
    const problem = check(value);
    return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
  } },
];

/** `<Form.Item name="code" validateFirst rules={productCodeRules()}>` — зөвхөн шинээр үүсгэхэд (код үүссэний дараа солигдохгүй). */
export const productCodeRules = (): Rule[] => textRules(t('admin.products.error.code_required'), productCodeProblem);
export const productTypeRules = (): Rule[] => textRules(t('admin.products.error.type_required'), productTypeProblem);
export const productNameRules = (): Rule[] => textRules(t('admin.products.error.name_required'), productNameProblem);
