// Хэлний кодын шалгалт: `-l` аргумент руу орох тул argument injection-ээс хатуу хамгаална (OCR_LANGUAGE_CODE_RE).
import { OCR_LANGUAGE_CODE_RE, OCR_MAX_LANGUAGES } from '../defaults';
import { OcrError } from '../types';

/** Хэлний кодуудыг шалгаж давхардлыг хасна. Буруу бол INVALID_INPUT (кодыг алдаанд давтахгүй). */
export function validateLanguages(languages: readonly string[]): string[] {
  if (!Array.isArray(languages) || languages.length === 0 || languages.length > OCR_MAX_LANGUAGES) {
    throw new OcrError('INVALID_INPUT', `OCR хэлний жагсаалт 1-${OCR_MAX_LANGUAGES} кодтой байх ёстой`);
  }
  for (const code of languages) {
    if (typeof code !== 'string' || !OCR_LANGUAGE_CODE_RE.test(code)) throw new OcrError('INVALID_INPUT', 'OCR хэлний код буруу (a-z, _ ; 3-12 тэмдэгт)');
  }
  return [...new Set(languages)];
}

/** 'mon+eng' / 'mon,eng' → ['mon','eng'] (env OCR_LANGUAGES). Буруу бол Error (тохиргооны алдаа, OcrError биш). */
export function parseLanguagesEnv(value: string): string[] {
  const codes = value.split(/[+,]/).map((s) => s.trim());
  try {
    return validateLanguages(codes);
  } catch {
    throw new Error('OCR_LANGUAGES буруу: "mon+eng" хэлбэртэй, код бүр a-z/_ 3-12 тэмдэгт байх ёстой');
  }
}
