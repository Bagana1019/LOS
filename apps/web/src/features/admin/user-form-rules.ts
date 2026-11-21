import type { Rule } from 'antd/es/form';
import { z } from 'zod';
import { CreateUserBody, normalizePhone } from '@los/contracts';
import { t } from '../../lib/i18n';

// F9-13: хэрэглэгч нэмэх/засах формын талбарын шалгалт (талбар бүрт Монголоор; "Required"/англи zod биш).
// Нэвтрэх нэр, бүтэн нэр, дүр — серверийн `CreateUserBody`-ийн schema-г өөрийг нь ажиллуулна (хоёр тал ижил дүрэм).
// И-мэйл — `CreateUserBody` формат шалгадаггүй тул (OptionalText) энд zod-ийн `email()` (харилцагчийн schema-тай ижил) нэмэв.
// Утас — admin schema-д дүрэм байхгүй; төслийн баримтжсан дүрэм: 8 цифр, +976/976 угтвар хасна (docs/DECISIONS.md M1 · форматууд, `normalizePhone`).

const asText = (v: unknown): string => (typeof v === 'string' ? v : '');
const EMAIL = z.string().email();
const PHONE_DIGITS = /^\d{8}$/;

export function usernameProblem(value: unknown): string | null {
  const text = asText(value);
  if (!text.trim()) return t('admin.users.error.username_required');
  return CreateUserBody.shape.username.safeParse(text).success ? null : t('admin.users.error.username_format');
}

export function fullNameProblem(value: unknown): string | null {
  const text = asText(value);
  if (!text.trim()) return t('admin.users.error.fullname_required');
  const parsed = CreateUserBody.shape.fullName.safeParse(text);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.code === 'too_small' ? t('admin.users.error.fullname_short') : t('admin.users.error.fullname_long');
}

/** Заавал биш: хоосон бол алдаагүй; бөглөсөн бол формат шалгана. */
export function emailProblem(value: unknown): string | null {
  const text = asText(value).trim();
  if (!text) return null;
  return EMAIL.safeParse(text).success ? null : t('admin.users.error.email_format');
}

/** "+976 9911-2233" → "99112233". Хоосон/буруу утгыг (trim-ээс өөр) өөрчлөхгүй — алдааг `phoneProblem` хэлнэ. */
export function normalizeUserPhone(value: unknown): string {
  const text = asText(value).trim();
  return text ? normalizePhone(text) : '';
}

/** Заавал биш: хоосон бол алдаагүй; бөглөсөн бол нормчилсны дараа 8 цифр байх ёстой. */
export function phoneProblem(value: unknown): string | null {
  const text = normalizeUserPhone(value);
  if (!text) return null;
  return PHONE_DIGITS.test(text) ? null : t('admin.users.error.phone_format');
}

export function rolesProblem(value: unknown): string | null {
  return Array.isArray(value) && value.length > 0 ? null : t('admin.users.error.roles_required');
}

const asRule = (check: (value: unknown) => string | null): Rule => ({
  validator: (_rule, value: unknown) => {
    const problem = check(value);
    return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
  },
});

/** `<Form.Item name="username" rules={usernameRules()}>` — зөвхөн шинэ хэрэглэгч нэмэхэд (нэвтрэх нэр солигдохгүй). */
export const usernameRules = (): Rule[] => [asRule(usernameProblem)];
export const fullNameRules = (): Rule[] => [asRule(fullNameProblem)];
export const emailRules = (): Rule[] => [asRule(emailProblem)];
export const phoneRules = (): Rule[] => [asRule(phoneProblem)];
export const rolesRules = (): Rule[] => [asRule(rolesProblem)];
