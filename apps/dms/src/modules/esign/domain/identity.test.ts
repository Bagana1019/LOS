import { describe, expect, it } from 'vitest';
import { maskName, maskPhone, maskRegister, normalizeRegister, registersMatch } from './identity';

const ZWSP = String.fromCharCode(0x200b);
const NBSP = String.fromCharCode(0xa0);
const EN_DASH = String.fromCharCode(0x2013);
const COMBINING_BREVE = String.fromCharCode(0x306);

describe('normalizeRegister', () => {
  it('зай, зураас хасаж, том үсэг болгоно', () => {
    expect(normalizeRegister('уа 12345678')).toBe('УА12345678');
    expect(normalizeRegister('  УА-1234 5678 ')).toBe('УА12345678');
    expect(normalizeRegister('УА\t12345678\n')).toBe('УА12345678');
  });

  it('латин look-alike-ыг кирилл болгоно: A B E K M H O P C T X Y', () => {
    expect(normalizeRegister('ABEKMHOPCTXY')).toBe('АВЕКМНОРСТХУ');
    expect(normalizeRegister('abekmhopctxy')).toBe('АВЕКМНОРСТХУ');
    expect(normalizeRegister('YA12345678')).toBe('УА12345678');
  });

  it('look-alike биш латин үсэг болон цифр хөндөгдөхгүй', () => {
    expect(normalizeRegister('DFGJLNQRSUVWZ0123456789')).toBe('DFGJLNQRSUVWZ0123456789');
  });

  it('Ө, Ү, Ё үсэг (том/жижиг) хадгалагдана', () => {
    expect(normalizeRegister('өү12345678')).toBe('ӨҮ12345678');
    expect(normalizeRegister('ёж 12345678')).toBe('ЁЖ12345678');
  });

  it('үл үзэгдэх тэмдэгт, NBSP, олон төрлийн зураас, NFC-ийн задарсан хэлбэрийг нэгтгэнэ', () => {
    expect(normalizeRegister(`УА${ZWSP}${NBSP}12345678`)).toBe('УА12345678');
    expect(normalizeRegister(`УА${EN_DASH}12345678`)).toBe('УА12345678');
    // Й = И + combining breve (NFD) → NFC-ийн нэг тэмдэгт
    expect(normalizeRegister(`И${COMBINING_BREVE}У12345678`)).toBe('ЙУ12345678');
    expect(normalizeRegister(`И${COMBINING_BREVE}У12345678`)).toBe(normalizeRegister('ЙУ12345678'));
  });

  it('идемпотент; хоосон оролт → хоосон', () => {
    const once = normalizeRegister('ya-12345678');
    expect(normalizeRegister(once)).toBe(once);
    expect(normalizeRegister('')).toBe('');
    expect(normalizeRegister(' - ')).toBe('');
  });
});

describe('registersMatch', () => {
  it('нормчилсон хэлбэрээр тэнцүү бол true (латин/кирилл, том/жижиг, зай)', () => {
    expect(registersMatch('УА12345678', 'УА12345678')).toBe(true);
    expect(registersMatch('УА12345678', 'ya 12345678')).toBe(true);
    expect(registersMatch('ya-12345678', 'уа12345678')).toBe(true);
    expect(registersMatch('ӨӨ00000001', 'өө-00000001')).toBe(true);
  });

  it('нэг цифр/үсэг ялгаатай, урт ялгаатай, өөр үсэг бол false', () => {
    expect(registersMatch('УА12345678', 'УА12345679')).toBe(false);
    expect(registersMatch('УА12345678', 'УБ12345678')).toBe(false);
    expect(registersMatch('УА12345678', 'УА1234567')).toBe(false);
    expect(registersMatch('УА12345678', 'УА123456789')).toBe(false);
    expect(registersMatch('УА12345678', 'УА12345678УА12345678')).toBe(false);
  });

  it('хоосон эсвэл зөвхөн тусгаарлагчтай оролтууд хэзээ ч таарахгүй', () => {
    expect(registersMatch('', '')).toBe(false);
    expect(registersMatch(' - ', '--')).toBe(false);
    expect(registersMatch('', 'УА12345678')).toBe(false);
    expect(registersMatch('УА12345678', '')).toBe(false);
  });

  it('look-alike биш латин үсэг кирилл-тэй таарахгүй (U ≠ У)', () => {
    expect(registersMatch('UA12345678', 'УА12345678')).toBe(false);
  });
});

describe('maskRegister', () => {
  it('эхний 2 + **** + сүүлийн 4', () => {
    expect(maskRegister('УА12345678')).toBe('УА****5678');
    expect(maskRegister('ya 12345678')).toBe('УА****5678'); // нормчилсон хэлбэрээр
    expect(maskRegister('ӨӨ00000001')).toBe('ӨӨ****0001');
  });

  it('дунд хэсгийн цифр гарахгүй', () => {
    const masked = maskRegister('УА12345678');
    expect(masked).not.toContain('1234');
    expect(masked).not.toContain('2345');
  });

  it('богино (<8) оролтыг бүхэлд нь далдалж, уртыг илрүүлэхгүй', () => {
    expect(maskRegister('УА1234')).toBe('****');
    expect(maskRegister('1234567')).toBe('****');
    expect(maskRegister('')).toBe('****');
  });

  it('урт (8+) регистр: дунд нь үргэлж 4 од (уртыг илрүүлэхгүй)', () => {
    expect(maskRegister('УА12345678')).toHaveLength(10);
    expect(maskRegister('ABCDEFGH12345678')).toBe('АВ****5678');
  });
});

describe('maskPhone', () => {
  it('сүүлийн 4 цифр', () => {
    expect(maskPhone('99112233')).toBe('+976 ****2233');
    expect(maskPhone('+97699112233')).toBe('+976 ****2233');
    expect(maskPhone('+976 9911 2233')).toBe('+976 ****2233');
  });

  it('4-өөс цөөн цифр бол цифргүй', () => {
    expect(maskPhone('123')).toBe('+976 ****');
    expect(maskPhone('')).toBe('+976 ****');
    expect(maskPhone('abc')).toBe('+976 ****');
  });

  it('эхний цифрүүд гарахгүй', () => {
    expect(maskPhone('99112233')).not.toContain('9911');
  });
});

describe('maskName', () => {
  it('"Бат-Эрдэнэ Болд" → "Б. Болд"', () => {
    expect(maskName('Бат-Эрдэнэ Болд')).toBe('Б. Болд');
  });

  it('гурав ба түүнээс олон үгтэй бол эхний үгийн үсэг + сүүлийн үг', () => {
    expect(maskName('Дорж Бат Болд')).toBe('Д. Болд');
    expect(maskName('Б. Бат Болд')).toBe('Б. Болд');
  });

  it('жижиг үсгээр эхэлсэн, илүүдэл зайтай нэр', () => {
    expect(maskName('  бат   болд  ')).toBe('Б. болд');
  });

  it('нэг үгтэй бол эхний үсэг + ***', () => {
    expect(maskName('Болд')).toBe('Б***');
    expect(maskName('  өлзий ')).toBe('Ө***');
  });

  it('хоосон бол ****', () => {
    expect(maskName('')).toBe('****');
    expect(maskName('   ')).toBe('****');
  });

  it('эхний үгийн үлдсэн хэсэг гарахгүй', () => {
    expect(maskName('Бат-Эрдэнэ Болд')).not.toContain('Эрдэнэ');
    expect(maskName('Бат-Эрдэнэ Болд')).not.toContain('Бат');
  });

  it('суррогат хос тэмдэгтийг (emoji) эвдэхгүй', () => {
    expect(maskName('\u{1F600}ab Болд')).toBe('\u{1F600}. Болд');
  });
});
