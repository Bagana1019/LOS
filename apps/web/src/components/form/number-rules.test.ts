import { describe, expect, it } from 'vitest';
import { moneyProblem, moneyRules, percentProblem, percentRules } from './number-rules';

// Дүрмүүд нь оролтын (NumberTextInput) гаргасан утгыг шалгана: undefined = хоосон, NaN = "тоо биш текст", бусад нь тоо.
const NOT_A_NUMBER = 'Зөвхөн тоо оруулна уу (жишээ: 1,500,000 эсвэл 5сая)';

describe('moneyProblem', () => {
  it('хоосон утга нь энд алдаа биш (заавал эсэхийг тусдаа required дүрэм шийднэ)', () => {
    expect(moneyProblem(undefined, {})).toBeNull();
    expect(moneyProblem(null, {})).toBeNull();
  });

  it('NaN / Infinity / тоо биш → "зөвхөн тоо"', () => {
    expect(moneyProblem(Number.NaN, {})).toBe(NOT_A_NUMBER);
    expect(moneyProblem(Number.POSITIVE_INFINITY, {})).toBe(NOT_A_NUMBER);
    expect(moneyProblem('abc', {})).toBe(NOT_A_NUMBER);
  });

  it('сөрөг дүнг чимээгүй 0 болгохгүй: тодорхой алдаа', () => {
    expect(moneyProblem(-100, {})).toBe('Сөрөг дүн оруулах боломжгүй');
    expect(moneyProblem(-0.5, { positive: true })).toBe('Сөрөг дүн оруулах боломжгүй');
  });

  it('0: positive үед алдаа, үгүй бол зөвшөөрнө', () => {
    expect(moneyProblem(0, {})).toBeNull();
    expect(moneyProblem(0, { positive: true })).toBe('Дүн 0-ээс их байх ёстой');
    expect(moneyProblem(0, { positive: true, label: 'Зээлийн дүн' })).toBe('Зээлийн дүн 0-ээс их байх ёстой');
  });

  it('бутархай: анхдагч 2 орон; 3 орон татгалзана (чимээгүй дугуйлахгүй)', () => {
    expect(moneyProblem(1234.56, {})).toBeNull();
    expect(moneyProblem(1.555, {})).toBe('Бутархай хэсэг 2 оронгоос ихгүй байх ёстой');
    expect(moneyProblem(1.5, { maxDecimals: 0 })).toBe('Бутархай хэсэг 0 оронгоос ихгүй байх ёстой');
  });

  it('дээд хязгаар: яг хязгаар зөв, түүнээс их алдаа', () => {
    const max = 1_000_000_000_000;
    expect(moneyProblem(max, { max })).toBeNull();
    expect(moneyProblem(max + 1, { max, label: 'Цалин' })).toBe('Цалин 1,000,000,000,000-аас ихгүй байх ёстой');
  });

  it('зөв утга → null', () => {
    expect(moneyProblem(5_000_000, { positive: true, max: 1e12 })).toBeNull();
  });
});

describe('percentProblem', () => {
  const fee = { label: 'Шимтгэлийн хувь', min: 0, max: 100, maxDecimals: 2 };

  it('хоосон → null; тоо биш → мессеж', () => {
    expect(percentProblem(undefined, fee)).toBeNull();
    expect(percentProblem(Number.NaN, fee)).toBe('Зөвхөн тоо оруулна уу (жишээ: 1.5)');
  });

  it('хүрээнээс гарвал clamp хийхгүй, мессеж өгнө', () => {
    expect(percentProblem(150, fee)).toBe('Шимтгэлийн хувь 0–100% хооронд байх ёстой');
    expect(percentProblem(-1, fee)).toBe('Шимтгэлийн хувь 0–100% хооронд байх ёстой');
    expect(percentProblem(100, fee)).toBeNull();
    expect(percentProblem(0, fee)).toBeNull();
  });

  it('бутархай: хувийн 2 орноос илүүг (1.555) татгалзана', () => {
    expect(percentProblem(1.55, fee)).toBeNull();
    expect(percentProblem(1.555, fee)).toBe('Бутархай хэсэг 2 оронгоос ихгүй байх ёстой');
    expect(percentProblem(12.3456, { ...fee, maxDecimals: 4 })).toBeNull();
  });
});

describe('moneyRules / percentRules (antd Form дүрмийн угсралт)', () => {
  const run = (rule: unknown, value: unknown) => (rule as { validator: (r: unknown, v: unknown) => Promise<void> }).validator({}, value);

  it('required: true үед эхний дүрэм required, мессежийг дарж болно', () => {
    expect(moneyRules({ required: true })[0]).toMatchObject({ required: true, message: 'Дүнг оруулна уу' });
    expect(moneyRules({ required: 'Заавал бөглөнө' })[0]).toMatchObject({ required: true, message: 'Заавал бөглөнө' });
    expect(moneyRules({})).toHaveLength(1);
  });

  it('validator нь асуудлыг Error болгон reject, зөв үед resolve', async () => {
    const [rule] = moneyRules({ positive: true });
    await expect(run(rule, -5)).rejects.toThrow('Сөрөг дүн оруулах боломжгүй');
    await expect(run(rule, Number.NaN)).rejects.toThrow(NOT_A_NUMBER);
    await expect(run(rule, 10)).resolves.toBeUndefined();
    await expect(run(rule, undefined)).resolves.toBeUndefined();
  });

  it('percentRules ижил бүтэцтэй', async () => {
    const rules = percentRules({ required: true, label: 'Хүү' });
    expect(rules).toHaveLength(2);
    await expect(run(rules[1], 150)).rejects.toThrow('Хүү 0–100% хооронд байх ёстой');
    await expect(run(rules[1], 23.99)).resolves.toBeUndefined();
  });
});
