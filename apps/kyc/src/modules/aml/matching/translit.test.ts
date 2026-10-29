import { describe, expect, it } from 'vitest';
import { transliterateCyrillic } from './translit';

describe('transliterateCyrillic', () => {
  it('maps the Mongolian-specific letters ө and ү to o and u', () => {
    expect(transliterateCyrillic('өү')).toBe('ou');
    expect(transliterateCyrillic('мөнх')).toBe('monkh');
  });

  it('maps digraph consonants: х->kh ц->ts ч->ch ш->sh ж->j', () => {
    expect(transliterateCyrillic('хцчшж')).toBe('khtschshj');
  });

  it('maps ё->yo ю->yu я->ya й->i э->e е->e', () => {
    expect(transliterateCyrillic('ёюяйэе')).toBe('yoyuyaiee');
  });

  it('maps щ->shch and ы->y', () => {
    expect(transliterateCyrillic('щукин')).toBe('shchukin');
    expect(transliterateCyrillic('сүхбаатарын')).toBe('sukhbaataryn');
  });

  it('drops the hard and soft signs ъ and ь', () => {
    expect(transliterateCyrillic('игорь')).toBe('igor');
    expect(transliterateCyrillic('ильяс')).toBe('ilyas');
    expect(transliterateCyrillic('объект')).toBe('obekt');
  });

  it('transliterates whole Mongolian names', () => {
    expect(transliterateCyrillic('бат-эрдэнэ ганболд')).toBe('bat-erdene ganbold');
    expect(transliterateCyrillic('өлзий')).toBe('olzii');
  });

  it('leaves Latin letters, digits, whitespace and punctuation untouched', () => {
    expect(transliterateCyrillic('bat-erdene 88, o\'brien')).toBe('bat-erdene 88, o\'brien');
    expect(transliterateCyrillic('')).toBe('');
  });

  it('keeps letters of other scripts as they are', () => {
    expect(transliterateCyrillic('محمد 中文')).toBe('محمد 中文');
  });

  it('maps a Cyrillic letter that carries a diacritic through its base letter', () => {
    expect(transliterateCyrillic('ӣ')).toBe('i');
  });

  it('handles mixed Cyrillic and Latin in one string', () => {
    expect(transliterateCyrillic('батаа bataa')).toBe('bataa bataa');
  });

  it('maps Kazakh, Tatar and Central Asian letters ә ғ қ ң ұ һ ҳ ҷ җ', () => {
    expect(transliterateCyrillic('әғқңұһҳҷҗ')).toBe('agknuhhjj');
    expect(transliterateCyrillic('нұрсұлтан қайрат ғалым')).toBe('nursultan kairat galym');
  });

  it('maps Ukrainian and Belarusian letters і ї є ґ ў', () => {
    expect(transliterateCyrillic('іїєґў')).toBe('iyiyegu');
    expect(transliterateCyrillic('олександр')).toBe('oleksandr');
  });

  it('maps Serbian and Macedonian letters ђ ћ ј љ њ џ ѕ (and ѓ ќ through their base letters)', () => {
    expect(transliterateCyrillic('ђћјљњџѕ')).toBe('djcjljnjdzdz');
    expect(transliterateCyrillic('ђорђе милошевић')).toBe('djordje miloshevic');
    expect(transliterateCyrillic('ѓќ')).toBe('gk');
  });

  it('drops the Chechen palochka and leaves no Cyrillic letter from rare or historic ones', () => {
    expect(transliterateCyrillic('аӏа')).toBe('aa');
    expect(transliterateCyrillic('ѣѳѵ')).toBe('efi');
    // Extended-B / Extended-C / Extended-D: хүснэгтэд байхгүй үсэг унана
    expect(transliterateCyrillic('a\u1c80\ua640\u{1e04a}ab')).toBe('aab');
  });

  it('leaves no Cyrillic letter behind for ANY Cyrillic code point, in lower or upper case', () => {
    let checked = 0;
    for (let cp = 0x400; cp <= 0x1e100; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!/^\p{Script=Cyrillic}$/u.test(ch)) continue;
      for (const variant of [ch, ch.toLowerCase(), ch.toUpperCase().toLowerCase()]) {
        const out = transliterateCyrillic(variant);
        expect(/\p{Script=Cyrillic}/u.test(out), `U+${cp.toString(16)} -> ${JSON.stringify(out)}`).toBe(false);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('keeps the Mongolian and Russian values unchanged', () => {
    expect(transliterateCyrillic('өүёйъыщ')).toBe('ouyoiyshch');
  });

  describe('oeAsU (passport rendering)', () => {
    it('renders ө as u instead of o, everything else as usual', () => {
      expect(transliterateCyrillic('өлзий', { oeAsU: true })).toBe('ulzii');
      expect(transliterateCyrillic('өлзий')).toBe('olzii');
      expect(transliterateCyrillic('мөнхөө', { oeAsU: true })).toBe('munkhuu');
      expect(transliterateCyrillic('ү', { oeAsU: true })).toBe('u');
    });
    it('does not touch Latin o', () => {
      expect(transliterateCyrillic('olzii', { oeAsU: true })).toBe('olzii');
    });
  });
});
