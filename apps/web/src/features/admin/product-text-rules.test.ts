import { describe, expect, it } from 'vitest';
import { ProductCode, ProductEditable, ProductType } from '@los/contracts';
import { productCodeProblem, productNameProblem, productTypeProblem } from './product-text-rules';

// F9-3: бүтээгдэхүүний код / төрөл / нэр. Алдаа талбар бүрт Монголоор ("UPPER_SNAKE_CASE", "String must contain…" биш); дүрэм нь серверийн `@los/contracts`-тай ижил.
const CODE_REQUIRED = 'Бүтээгдэхүүний кодыг оруулна уу (жишээ: SME_PLUS)';
const CODE_FORMAT = 'Код: зөвхөн ТОМ латин үсэг, тоо, _ (жишээ: SME_PLUS). Эхний тэмдэгт үсэг, 2–32 тэмдэгт; кирилл, жижиг үсэг, зай болохгүй';
const TYPE_REQUIRED = 'Бүтээгдэхүүний төрлийг оруулна уу (жишээ: BUSINESS)';
const TYPE_FORMAT = 'Төрөл: зөвхөн ТОМ латин үсэг, тоо, _ (жишээ: BUSINESS). Эхний тэмдэгт үсэг, 2–32 тэмдэгт; кирилл, жижиг үсэг, зай болохгүй';
const NAME_REQUIRED = 'Бүтээгдэхүүний нэрийг оруулна уу';
const NAME_INVALID = 'Нэр 1–200 тэмдэгттэй, хориглосон тэмдэгтгүй байх ёстой';

const EMPTY = [[''], ['   '], [undefined], [null]] as const;
const BAD_SNAKE = [['Хэрэглээний зээл 2'], ['sme_plus'], ['SME PLUS'], ['1ABC'], ['_ABC'], ['A'], ['SME-PLUS'], ['A'.repeat(33)]] as const;
const GOOD_SNAKE = [['SME_PLUS'], ['AB'], ['A1'], ['A'.repeat(32)], ['  SME_PLUS  ']] as const;

describe('productCodeProblem', () => {
  it.each(EMPTY)('хоосон код (%j) → заавал оруулах', (v) => expect(productCodeProblem(v)).toBe(CODE_REQUIRED));
  it.each(BAD_SNAKE)('буруу код (%j) → ТОМ латин үсэг/тоо/_ гэж заана, жишээтэй', (v) => expect(productCodeProblem(v)).toBe(CODE_FORMAT));
  it.each(GOOD_SNAKE)('зөв код (%j) → алдаагүй', (v) => expect(productCodeProblem(v)).toBeNull());

  it('серверийн ProductCode-той ижил шийдвэр (форм trim хийж илгээдэг)', () => {
    for (const [v] of [...BAD_SNAKE, ...GOOD_SNAKE, ['']] as const) {
      expect(productCodeProblem(v) === null, `код ${JSON.stringify(v)}`).toBe(ProductCode.safeParse(v.trim()).success);
    }
  });

  it('"UPPER_SNAKE_CASE" гэсэн нэр томьёо хэрэглэгчид харагдахгүй', () => {
    expect(productCodeProblem('тест')).not.toMatch(/UPPER_SNAKE_CASE/);
  });
});

describe('productTypeProblem', () => {
  it.each(EMPTY)('хоосон төрөл (%j) → заавал оруулах', (v) => expect(productTypeProblem(v)).toBe(TYPE_REQUIRED));
  it.each(BAD_SNAKE)('буруу төрөл (%j) → ТОМ латин үсэг/тоо/_ гэж заана, жишээтэй', (v) => expect(productTypeProblem(v)).toBe(TYPE_FORMAT));
  it.each(GOOD_SNAKE)('зөв төрөл (%j) → алдаагүй', (v) => expect(productTypeProblem(v)).toBeNull());

  it('серверийн ProductType-той ижил шийдвэр', () => {
    for (const [v] of [...BAD_SNAKE, ...GOOD_SNAKE, ['']] as const) {
      expect(productTypeProblem(v) === null, `төрөл ${JSON.stringify(v)}`).toBe(ProductType.safeParse(v).success);
    }
  });
});

describe('productNameProblem', () => {
  it.each(EMPTY)('хоосон нэр (%j) → заавал оруулах', (v) => expect(productNameProblem(v)).toBe(NAME_REQUIRED));
  it.each([['Хэрэглээний зээл'], ['ЖДҮ+'], ['Б'.repeat(200)], ['  ЖДҮ  ']])('зөв нэр (%j) → алдаагүй', (v) => expect(productNameProblem(v)).toBeNull());
  it.each([['Б'.repeat(201)], ['нэр\u0000']])('буруу нэр (%j) → хэмжээ/тэмдэгтийн мессеж', (v) => expect(productNameProblem(v)).toBe(NAME_INVALID));

  it('серверийн ProductEditable.name-тэй ижил шийдвэр', () => {
    for (const v of ['ЖДҮ+', '  ', 'Б'.repeat(200), 'Б'.repeat(201), 'нэр\u0000', 'x']) {
      expect(productNameProblem(v) === null, `нэр ${JSON.stringify(v)}`).toBe(ProductEditable.shape.name.safeParse(v).success);
    }
  });

  it('англи zod мессеж байхгүй', () => {
    for (const v of ['', 'Б'.repeat(201)]) expect(productNameProblem(v)).not.toMatch(/String|character|Required/);
  });
});
