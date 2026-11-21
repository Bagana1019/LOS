import type { Rule } from 'antd/es/form';
import { CreateBranchBody } from '@los/contracts';
import { t } from '../../lib/i18n';

// F9-12: салбар нэмэх формын талбарын шалгалт. Дүрмийн эх сурвалж нь серверийн `CreateBranchBody` (код: trim + том үсэг + латин/тоо 1–12; нэр: trim 2–120) —
// энд тэр schema-г өөрийг нь ажиллуулж, зөвхөн мессежийг талбар бүрт Монголоор тодорхой болгоно (англи zod / "Required" биш).

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Салбарын кодын асуудлын мессеж эсвэл null (зөв). */
export function branchCodeProblem(value: unknown): string | null {
  const text = asText(value);
  if (!text.trim()) return t('admin.branches.error.code_required');
  return CreateBranchBody.shape.code.safeParse(text).success ? null : t('admin.branches.error.code_format');
}

/** Салбарын нэрийн асуудлын мессеж эсвэл null (зөв). */
export function branchNameProblem(value: unknown): string | null {
  const text = asText(value);
  if (!text.trim()) return t('admin.branches.error.name_required');
  const parsed = CreateBranchBody.shape.name.safeParse(text);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.code === 'too_small' ? t('admin.branches.error.name_short') : t('admin.branches.error.name_long');
}

const asRule = (check: (value: unknown) => string | null): Rule => ({
  validator: (_rule, value: unknown) => {
    const problem = check(value);
    return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
  },
});

/** `<Form.Item name="code" rules={branchCodeRules()}>` — зөвхөн шинэ салбар нэмэхэд (засахад код өөрчлөгдөхгүй). */
export const branchCodeRules = (): Rule[] => [asRule(branchCodeProblem)];
/** `<Form.Item name="name" rules={branchNameRules()}>` */
export const branchNameRules = (): Rule[] => [asRule(branchNameProblem)];
