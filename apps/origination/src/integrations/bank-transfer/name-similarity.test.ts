import { describe, expect, it } from 'vitest';
import { diceCoefficient, isNameMatch, levenshtein, levenshteinRatio, nameSimilarity, normalizeName, NAME_MATCH_THRESHOLD } from './name-similarity';

describe('name-similarity (FR-12.4)', () => {
  it('normalizeName: том/жижиг үсэг, зай, тэмдэгт', () => {
    expect(normalizeName('  БАТ-ЭРДЭНЭ   Дорж. ')).toBe('бат эрдэнэ дорж');
    expect(normalizeName('Бат-Эрдэнэ Дорж')).toBe(normalizeName('бат эрдэнэ  ДОРЖ'));
  });

  it('Ө/Ү нь О/У-аас ӨӨР үсэг — нормчлолд хутгагдахгүй', () => {
    expect(normalizeName('Өлзий')).toBe('өлзий');
    expect(normalizeName('Өлзий')).not.toBe(normalizeName('Олзий'));
    expect(normalizeName('Үүрцайх')).toBe('үүрцайх');
  });

  it('levenshtein ба ratio', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('өлзий', 'олзий')).toBe(1);
    expect(levenshteinRatio('бат', 'бат')).toBe(1);
    expect(levenshteinRatio('', '')).toBe(0);
  });

  it('dice коэффициент', () => {
    expect(diceCoefficient('night', 'nacht')).toBeCloseTo(0.25, 5);
    expect(diceCoefficient('бат', 'бат')).toBe(1);
    expect(diceCoefficient('а', 'а')).toBe(1);
    expect(diceCoefficient('аб', 'вг')).toBe(0);
  });

  it('ижил нэр = 1; том/жижиг, зай, зураас ялгаагүй', () => {
    expect(nameSimilarity('Бат-Эрдэнэ Дорж', 'БАТ ЭРДЭНЭ ДОРЖ')).toBe(1);
  });

  it('үгийн дараалал солигдсон нэр таарна', () => {
    expect(nameSimilarity('Дорж Бат-Эрдэнэ', 'Бат-Эрдэнэ Дорж')).toBe(1);
  });

  it('Ө/О ялгаатай нэр босгоос доош (богино нэрэнд нэг үсгийн зөрүү мэдэгдэхүйц)', () => {
    const s = nameSimilarity('Өлзий', 'Олзий');
    expect(s).toBeLessThan(NAME_MATCH_THRESHOLD);
    expect(isNameMatch(s)).toBe(false);
    expect(nameSimilarity('Үүрцайх Төмөр', 'Уурцайх Томор')).toBeLessThan(NAME_MATCH_THRESHOLD);
  });

  it('жижиг хэвлэлийн алдаа урт нэрэнд босгыг давна, өөр хүн давахгүй', () => {
    expect(isNameMatch(nameSimilarity('Сарангэрэл Болдбаатар', 'Сарангэрэл Болдбатар'))).toBe(true);
    expect(isNameMatch(nameSimilarity('Сарангэрэл Болд', 'Тэмүүлэн Пүрэв'))).toBe(false);
  });

  it('хоосон нэр = 0', () => {
    expect(nameSimilarity('', 'Бат')).toBe(0);
    expect(nameSimilarity('  ', ' - ')).toBe(0);
  });

  it('босго 0.85', () => {
    expect(NAME_MATCH_THRESHOLD).toBe(0.85);
    expect(isNameMatch(0.85)).toBe(true);
    expect(isNameMatch(0.8499)).toBe(false);
  });
});
