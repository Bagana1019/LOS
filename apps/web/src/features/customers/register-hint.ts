import { customerTypeOfRegister, normalizeRegisterNo } from '@los/contracts';

/** Регистрийн хэлбэр: 2 үсэг (кирилл эсвэл Latin) + 0…8 цифр. Бүрэн, зөв (кирилл + 8 цифр) нь `customerTypeOfRegister`-ээр тусдаа таарна. */
const REGISTER_SHAPE = /^[A-ZА-ЯЁӨҮ]{2}\d{0,8}$/u;
const LATIN = /[A-Za-z]/;

export const hasLatinLetters = (s: string): boolean => LATIN.test(s);

export type RegisterInputProblem = 'LATIN' | 'INVALID';

/** F1-5: /customer/new регистрийн талбар. Latin гараар "UB99010112" бичвэл «буруу» биш, кирилл үсгээр бичихийг хэлнэ. Зөв бол null. */
export function registerInputProblem(input: string): RegisterInputProblem | null {
  const normalized = normalizeRegisterNo(input);
  if (customerTypeOfRegister(normalized)) return null;
  return hasLatinLetters(normalized) && REGISTER_SHAPE.test(normalized) ? 'LATIN' : 'INVALID';
}

export type RegisterSearchHint = 'LATIN' | 'PARTIAL';

/**
 * F1-1: жагсаалтын хайлт хоосон үед. Регистрийг blind index-ээр ЗӨВХӨН бүтнээр нь тулгадаг тул хэсэгчилсэн ("УБ", "УБ9901") эсвэл Latin ("UB…") регистр «олдсонгүй» гарна.
 * Бүрэн, зөв регистр (хайлт аль хэдийн тулгана), нэр, утас, хоосон үед null.
 */
export function registerSearchHint(term: string): RegisterSearchHint | null {
  const normalized = normalizeRegisterNo(term);
  if (!REGISTER_SHAPE.test(normalized) || customerTypeOfRegister(normalized)) return null;
  return hasLatinLetters(normalized) ? 'LATIN' : 'PARTIAL';
}
