import { describe, expect, it } from 'vitest';
import { containsInsensitive } from './contains-insensitive';

// F9-24 · Prisma `contains` нь LIKE-ийн "%", "_", "\"-г escape хийдэггүй → хэрэглэгчийн бичсэн текстийг шууд тэмдэгт болгоно.
describe('containsInsensitive', () => {
  it('том/жижиг үсэг үл ялгах хэсэгчилсэн (contains + insensitive) шүүлт буцаана', () => {
    expect(containsInsensitive('setting')).toEqual({ contains: 'setting', mode: 'insensitive' });
  });

  it('"%" -г шууд тэмдэгт болгоно (wildcard биш)', () => {
    expect(containsInsensitive('100%').contains).toBe('100\\%');
  });

  it('"_" -г шууд тэмдэгт болгоно (нэг тэмдэгтийн wildcard биш)', () => {
    expect(containsInsensitive('a_b').contains).toBe('a\\_b');
  });

  it('"\\" -г өөрийг нь escape хийнэ (давхар escape-гүй)', () => {
    expect(containsInsensitive('a\\b').contains).toBe('a\\\\b');
    expect(containsInsensitive('\\%').contains).toBe('\\\\\\%');
  });

  it('бүх тусгай тэмдэгт нэг дор: "a_b%c\\d"', () => {
    expect(containsInsensitive('a_b%c\\d').contains).toBe('a\\_b\\%c\\\\d');
  });

  it('энгийн, кирилл, emoji, SQL тэмдэгтийг хөндөхгүй', () => {
    for (const v of ['SETTING', 'Тохиргоо', 'x😀y', "o'brien; DROP TABLE"]) {
      expect(containsInsensitive(v).contains).toBe(v);
    }
  });

  it('хоосон мөр → хоосон contains (дуудагч өөрөө алгасна)', () => {
    expect(containsInsensitive('').contains).toBe('');
  });

  it('дуудлага бүрд шинэ объект буцаана', () => {
    const a = containsInsensitive('x');
    expect(a).not.toBe(containsInsensitive('x'));
    expect(a).toEqual(containsInsensitive('x'));
  });
});
