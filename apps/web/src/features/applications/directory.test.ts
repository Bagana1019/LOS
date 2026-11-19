import { describe, expect, it } from 'vitest';
import type { OrgDirectory } from '@los/contracts';
import { hasMessage, t } from '../../lib/i18n';
import { directoryLabels } from './directory';

// FR-1.2 (M2): Салбар / Хариуцсан ЗЭЗ баганад ХЭЗЭЭ Ч UUID харуулахгүй — нэр, эсвэл "Тодорхойгүй" / "—" / "Систем".
const TEXT = { unknown: 'Тодорхойгүй', system: 'Систем' };
const BRANCH_ID = '00000000-0000-4000-8000-000000000101';
const OFFICER_ID = '00000000-0000-4000-8000-000000000201';
const GHOST_ID = 'a3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const dir: OrgDirectory = { branches: { [BRANCH_ID]: 'Төв салбар' }, users: { [OFFICER_ID]: 'ЗЭЗ А' } };

describe('directoryLabels.branch', () => {
  const l = directoryLabels(dir, false, TEXT);
  it('мэдэгдэх id → салбарын нэр', () => expect(l.branch(BRANCH_ID)).toBe('Төв салбар'));
  it('лавлахад байхгүй id → "Тодорхойгүй" (UUID биш)', () => expect(l.branch(GHOST_ID)).toBe('Тодорхойгүй'));
  it('салбаргүй (null / undefined) → "—"', () => {
    expect(l.branch(null)).toBe('—');
    expect(l.branch(undefined)).toBe('—');
  });
});

describe('directoryLabels.officer', () => {
  const l = directoryLabels(dir, false, TEXT);
  it('мэдэгдэх id → ЗЭЗ-ийн нэр', () => expect(l.officer(OFFICER_ID)).toBe('ЗЭЗ А'));
  it('лавлахад байхгүй id → "Тодорхойгүй" (UUID биш)', () => expect(l.officer(GHOST_ID)).toBe('Тодорхойгүй'));
  it('ЗЭЗ-гүй (системээс үүссэн: null) → "Систем"', () => expect(l.officer(null)).toBe('Систем'));
});

describe('лавлах ачаалж байх / ачаалж чадаагүй үед', () => {
  it('ачаалж байхад (хараахан ирээгүй) UUID биш "—"', () => {
    const l = directoryLabels(undefined, true, TEXT);
    expect(l.branch(BRANCH_ID)).toBe('—');
    expect(l.officer(OFFICER_ID)).toBe('—');
  });
  it('ачаалж байхад ч ЗЭЗ-гүй мөр "Систем" хэвээр (лавлах хэрэггүй)', () => {
    expect(directoryLabels(undefined, true, TEXT).officer(null)).toBe('Систем');
  });
  it('ачаалж чадаагүй (алдаа) үед "Тодорхойгүй" — UUID руу буцахгүй', () => {
    const l = directoryLabels(undefined, false, TEXT);
    expect(l.branch(BRANCH_ID)).toBe('Тодорхойгүй');
    expect(l.officer(OFFICER_ID)).toBe('Тодорхойгүй');
  });
});

describe('хязгаарын тохиолдол', () => {
  it('хоосон / зөвхөн хоосон зайтай нэр → "Тодорхойгүй"', () => {
    const l = directoryLabels({ branches: { b: '', c: '   ' }, users: { u: '  ' } }, false, TEXT);
    expect(l.branch('b')).toBe('Тодорхойгүй');
    expect(l.branch('c')).toBe('Тодорхойгүй');
    expect(l.officer('u')).toBe('Тодорхойгүй');
  });
  it('Object.prototype-ийн түлхүүртэй id нь функц/объект биш "Тодорхойгүй" буцаана', () => {
    const l = directoryLabels({ branches: {}, users: {} }, false, TEXT);
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(l.branch(k), k).toBe('Тодорхойгүй');
      expect(l.officer(k), k).toBe('Тодорхойгүй');
    }
  });
  it('нэрний эргэн тойрны хоосон зайг тайрна', () => {
    expect(directoryLabels({ branches: { b: '  Төв  ' }, users: {} }, false, TEXT).branch('b')).toBe('Төв');
  });
  it('10 000 ажилтантай лавлах дээр ч зөв нэрийг олно', () => {
    const users = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`u${i}`, `Ажилтан ${i}`]));
    const l = directoryLabels({ branches: {}, users }, false, TEXT);
    expect(l.officer('u9999')).toBe('Ажилтан 9999');
  });
  it('юу ч ирсэн id-г буцаахгүй (UUID-тай төстэй ямар ч утга)', () => {
    const l = directoryLabels(dir, false, TEXT);
    for (let i = 0; i < 50; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '9')}`;
      expect(l.branch(id)).not.toContain(id);
      expect(l.officer(id)).not.toContain(id);
    }
  });
});

describe('i18n', () => {
  it('"Тодорхойгүй" түлхүүр толь бичигт байна', () => {
    expect(hasMessage('application.directory.unknown')).toBe(true);
    expect(t('application.directory.unknown')).toBe('Тодорхойгүй');
  });
});
