import { describe, expect, it } from 'vitest';
import { CONFUSABLE_TO_LATIN, joinTokens, normalizeName, normalizeNameForms, tokenize, vowelVariant } from './normalize';
import { transliterateCyrillic } from './translit';

describe('normalizeName', () => {
  it('lowercases and strips diacritics', () => {
    expect(normalizeName('José')).toBe('jose');
    expect(normalizeName('ÉMILE ZOLA')).toBe('emile zola');
    expect(normalizeName('Çelik Ñandú')).toBe('celik nandu');
  });

  it('applies compatibility decomposition (full-width and ligatures)', () => {
    expect(normalizeName('ＢＡＴ　ＥＲＤＥＮＥ')).toBe('bat erdene');
    expect(normalizeName('ﬁrst')).toBe('first');
  });

  it('turns hyphens, underscores, dots, commas and slashes into spaces', () => {
    expect(normalizeName('Bat-Erdene_Ganbold.Dorj,Bold/Tsetseg\\Nyam')).toBe('bat erdene ganbold dorj bold tsetseg nyam');
    expect(normalizeName('Al–Rashid')).toBe('al rashid');
  });

  it('removes apostrophes and quotes without splitting the word', () => {
    expect(normalizeName("O'Brien")).toBe('obrien');
    expect(normalizeName('D’Souza')).toBe('dsouza');
    expect(normalizeName('ʻAbd "Ali" “Khan”')).toBe('abd ali han');
  });

  it('removes any other non-alphanumeric character', () => {
    expect(normalizeName('Ganbold (Bat) #1!')).toBe('ganbold bat 1');
    expect(normalizeName('Bat@Erdene*Ganbold')).toBe('baterdeneganbold');
  });

  it('collapses repeated whitespace and trims', () => {
    expect(normalizeName('  Bat \t Erdene\n\nGanbold  ')).toBe('bat erdene ganbold');
  });

  it('returns an empty string for empty, blank and punctuation-only input', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   \t ')).toBe('');
    expect(normalizeName('-- ... //,,_ \'"')).toBe('');
  });

  it('keeps digits, including in company names', () => {
    expect(normalizeName('Монгол Трейд 88 ХХК')).toBe('mongol treid 88 hk');
    expect(normalizeName('Company 1998 LLC')).toBe('company 1998 lc');
    expect(normalizeName('88')).toBe('88');
  });

  it('transliterates Mongolian Cyrillic including Өө and Үү', () => {
    expect(normalizeName('Бат-Эрдэнэ Ганболд')).toBe('bat erdene ganbold');
    expect(normalizeName('Мөнхсайхан')).toBe('monhsaihan');
    expect(normalizeName('ӨҮ')).toBe('ou');
    expect(normalizeName('Батаа Өлзий')).toBe('bata olzi');
  });

  it('transliterates Russian letters ё й ъ ь ы э ю я щ', () => {
    expect(normalizeName('Пётр Игорь Ильяс')).toBe('pyotr igor ilyas');
    expect(normalizeName('Юрий Яковлев')).toBe('yuri yakovlev');
    expect(normalizeName('Щукин Рыбаков Эдуард')).toBe('shchukin rybakov eduard');
  });

  it('keeps ё as yo even when the input is decomposed (NFD)', () => {
    expect(normalizeName('Пётр'.normalize('NFD'))).toBe('pyotr');
    expect(normalizeName('Краткий'.normalize('NFD'))).toBe(normalizeName('Краткий'));
  });

  it('folds kh->h, ph->f, ck->k, zh->j, q->k, w->v, x->ks', () => {
    expect(normalizeName('Zhargal')).toBe('jargal');
    expect(normalizeName('Dzhamal')).toBe('djamal');
    expect(normalizeName('Khalid')).toBe('halid');
    expect(normalizeName('Philip')).toBe('filip');
    expect(normalizeName('Jackson')).toBe('jakson');
    expect(normalizeName('Qasim')).toBe('kasim');
    expect(normalizeName('Wael')).toBe('vael');
    expect(normalizeName('Alexander')).toBe('aleksander');
  });

  it('collapses repeated letters but never repeated digits', () => {
    expect(normalizeName('Muhammad')).toBe('muhamad');
    expect(normalizeName('Aaaabbb 1100')).toBe('ab 1100');
  });

  it('gives Cyrillic and Latin spellings the same normal form', () => {
    expect(normalizeName('Хүрэлсүх')).toBe(normalizeName('Khurelsukh'));
    expect(normalizeName('Цэцэгмаа')).toBe(normalizeName('Tsetsegmaa'));
  });

  it('keeps letters of other scripts', () => {
    expect(normalizeName('محمد')).toBe('محمد');
    expect(normalizeName('王 小明')).toBe('王 小明');
  });

  it('resolves fold chains to a stable form', () => {
    expect(normalizeName('pkkh')).toBe('f');
    expect(normalizeName('cckk')).toBe('k');
    expect(normalizeName('zkh')).toBe('j');
  });

  it('is idempotent over a table of inputs', () => {
    const inputs = [
      '', '   ', '---', 'José', 'Бат-Эрдэнэ Ганболд', 'Мөнхсайхан', 'Өлзий Үүрийнтуяа', 'Пётр Игорь Щукин',
      "O'Brien-D’Souza", 'Alexander Petrov', 'Khalid Ph.D. Jackson Qasim Wael', 'pkkh ckk kkh phh',
      'ＢＡＴ　ＥＲＤＥＮＥ', 'ﬃ Straße İstanbul', 'Монгол Трейд 88 ХХК', 'Company 1998 LLC', 'Aaaabbb 1100',
      'Ӣ ӣ ѐ', 'é ̈ x́w', '½ № ㎑', '한국 王 小明 محمد', 'Σίσυφος ΐ', 'ǅ ǆ Ǆ',
    ];
    for (const input of inputs) {
      const once = normalizeName(input);
      expect(normalizeName(once), JSON.stringify(input)).toBe(once);
    }
  });

  it('is idempotent over generated strings that exercise the fold rules', () => {
    const pieces = ['k', 'h', 'c', 'p', 'x', 'q', 'w', 'z', 'ж', 'ı', 'ß', 'ø', 'đ', 'х', 'ё', 'й', 'ъ', '-', "'", ' ', '8'];
    let seed = 7;
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let i = 0; i < 500; i++) {
      const input = Array.from({ length: 1 + next(14) }, () => pieces[next(pieces.length)]).join('');
      const once = normalizeName(input);
      expect(normalizeName(once), JSON.stringify(input)).toBe(once);
    }
  });

  it('finishes quickly on a 1,000 character input', () => {
    const input = 'Бат-Эрдэнэ Khalid '.repeat(56).slice(0, 1000);
    const start = performance.now();
    const result = normalizeName(input);
    expect(performance.now() - start).toBeLessThan(500);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('normalizeName: Latin letters NFKD does not decompose (review [2])', () => {
  // NFKD-ээр суурь үсэг болдоггүй тусдаа латин үсэг бүр: жижиг ба том хувилбар хоёулаа
  it.each([
    ['ı', 'kilic', 'Kılıç'], ['İ', 'istanbul', 'İstanbul'], ['đ', 'duc', 'đức'], ['Đ', 'duc', 'ĐỨC'], ['ð', 'dora', 'ðóra'], ['Ð', 'dora', 'ÐÓRA'],
    ['ł', 'lukasz', 'łukasz'], ['Ł', 'lukasz', 'ŁUKASZ'], ['ø', 'bjorn', 'bjørn'], ['Ø', 'bjorn', 'BJØRN'], ['æ', 'aero', 'ærø'], ['Æ', 'aero', 'ÆRØ'],
    ['œ', 'oeuvre', 'œuvre'], ['Œ', 'oeuvre', 'ŒUVRE'], ['ß', 'strase', 'straße'], ['ẞ', 'strase', 'STRAẞE'], ['þ', 'thordur', 'þórður'], ['Þ', 'thordur', 'ÞÓRÐUR'],
  ])('%s is folded: %s', (_letter, expected, input) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it('makes the Turkish dotless i case-insensitive', () => {
    expect(normalizeName('Kılıç')).toBe(normalizeName('KILIÇ'));
    expect(normalizeName('Kılıç')).toBe(normalizeName('Kilic'));
  });
});

describe('vowelVariant', () => {
  it('maps o to u and e to a on a normalised token, then re-folds doubled letters', () => {
    expect(vowelVariant('mohamed')).toBe('muhamad');
    expect(vowelVariant('omar')).toBe('umar');
    expect(vowelVariant('hosein')).toBe('husain');
    expect(vowelVariant('mousa')).toBe('musa'); // ou → uu → u
    expect(vowelVariant('sean')).toBe('san'); // ea → aa → a
  });

  it('leaves a token without o or e untouched and is idempotent', () => {
    expect(vowelVariant('bat')).toBe('bat');
    expect(vowelVariant('88')).toBe('88');
    for (const token of ['mohamed', 'omar', 'hosein', 'mousa', 'erdene', 'ganbold']) {
      expect(vowelVariant(vowelVariant(token)), token).toBe(vowelVariant(token));
    }
  });

  it('maps the main spelling variants onto one form', () => {
    expect(vowelVariant(normalizeName('Mohammed'))).toBe(vowelVariant(normalizeName('Muhammad')));
    expect(vowelVariant(normalizeName('Hossein'))).toBe(vowelVariant(normalizeName('Hussein')));
    expect(vowelVariant(normalizeName('Omar'))).toBe(vowelVariant(normalizeName('Umar')));
  });
});

describe('mixed-script confusables', () => {
  // Хүснэгтийн мөр бүр ЯГ энд жагсаагдсан (эх кодын хүснэгтээс өөрөөс нь уншдаггүй): мөр устгавал, нэмбэл эсвэл буруу үсэг оноовол унана.
  // Эхний арван хоёр нь дуудлагаар хөрвүүлэхэд мөн адил латин үсэг болдог (а→a), сүүлийн арав нь дүрсээр л латин (с→c, у→y, х→x).
  const EXPECTED: readonly (readonly [string, string])[] = [
    ['а', 'a'], ['е', 'e'], ['к', 'k'], ['м', 'm'], ['о', 'o'], ['т', 't'], ['і', 'i'], ['ј', 'j'], ['һ', 'h'], ['ԁ', 'd'], ['ԛ', 'q'], ['ԝ', 'w'],
    ['в', 'b'], ['н', 'h'], ['р', 'p'], ['с', 'c'], ['у', 'y'], ['х', 'x'], ['ү', 'y'], ['ѕ', 's'], ['ӏ', 'l'], ['ѵ', 'v'],
  ];

  it('lists exactly the documented 22 look-alike letters', () => {
    expect(Object.entries(CONFUSABLE_TO_LATIN).sort()).toEqual([...EXPECTED].map(([c, l]) => [c, l]).sort());
    expect(EXPECTED).toHaveLength(22);
  });

  // Латин үсэгтэй нэг үгэнд орсон кирилл үсэг бүр дүрсээр нь латин болж, skeleton хэлбэр дотор орно
  it.each(EXPECTED.map(([c, l]) => [c, l]))('Cyrillic %s inside a Latin word also reads as the Latin letter %s', (cyrillic, latin) => {
    const forms = normalizeNameForms(`a${cyrillic}`);
    expect(forms, cyrillic).toContain(normalizeName(`a${latin}`));
  });

  it.each(EXPECTED.slice(12).map(([c, l]) => [c, l]))('%s (shape %s) differs from its phonetic reading, so only the skeleton form can match', (cyrillic, latin) => {
    expect(transliterateCyrillic(cyrillic)).not.toBe(latin);
    // дуудлагын хэлбэр ганцаараа таарахгүй, skeleton хэлбэр нэмэгдэнэ
    const forms = normalizeNameForms(`pa${cyrillic}pal`);
    expect(forms.length, cyrillic).toBeGreaterThan(1);
    expect(forms, cyrillic).toContain(normalizeName(`pa${latin}pal`));
    expect(normalizeName(`pa${cyrillic}pal`), cyrillic).not.toBe(normalizeName(`pa${latin}pal`));
  });

  it('only words that mix both scripts are rewritten', () => {
    // цэвэр кирилл үг нь дуудлагаар хөрвөнө (р→r), skeleton нэмэгдэхгүй
    expect(normalizeNameForms('Рауpal').length).toBeGreaterThan(1);
    expect(normalizeNameForms('Ромашка')).toEqual([normalizeName('Ромашка')]);
    expect(normalizeNameForms('Paypal')).toEqual(['paypal']);
  });
});

describe('normalizeName: every Cyrillic letter ends up Latin', () => {
  it('transliterates Kazakh, Ukrainian, Serbian and Belarusian names', () => {
    expect(normalizeName('Нұрсұлтан Назарбаев')).toBe('nursultan nazarbaev');
    expect(normalizeName('Қайрат Әлібек Ғабит')).toBe('kairat alibek gabit');
    expect(normalizeName('Олександр Ґрунт')).toBe('oleksandr grunt');
    expect(normalizeName('Ђорђе Милошевић')).toBe('djordje miloshevic');
    expect(normalizeName('Лукашэнка Ўладзімір')).toBe('lukashenka uladzimir');
  });

  it('puts Kazakh and Latin spellings of the same name onto one normal form', () => {
    expect(normalizeName('Қайрат')).toBe(normalizeName('Kairat'));
    expect(normalizeName('Әлібек')).toBe(normalizeName('Alibek'));
  });

  it('never leaves a Cyrillic letter in the output for any Cyrillic code point', () => {
    for (let cp = 0x400; cp <= 0x1e100; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!/^\p{Script=Cyrillic}$/u.test(ch)) continue;
      const out = normalizeName(`a${ch}b`);
      expect(/\p{Script=Cyrillic}/u.test(out), `U+${cp.toString(16)}`).toBe(false);
    }
  });
});

describe('normalizeNameForms', () => {
  it('starts with normalizeName and has no other form for an ordinary name', () => {
    expect(normalizeNameForms('Бат-Эрдэнэ Ганболд')).toEqual(['bat erdene ganbold']);
    expect(normalizeNameForms('Mohammed Al-Rashid')).toEqual([normalizeName('Mohammed Al-Rashid')]);
    expect(normalizeNameForms('Мөнхсайхан')[0]).toBe(normalizeName('Мөнхсайхан'));
  });

  it('returns [""] for names with nothing left to compare', () => {
    expect(normalizeNameForms('---')).toEqual(['']);
    expect(normalizeNameForms('\u200b')).toEqual(['']);
  });

  it('adds the passport rendering (ө as u) when the name contains ө', () => {
    expect(normalizeNameForms('Өлзий')).toEqual(['olzi', 'ulzi']);
    expect(normalizeNameForms('Өлзий Мөнхөө')).toEqual(['olzi monho', 'ulzi munhu']);
    expect(normalizeNameForms('Үүрэнтуяа')).toHaveLength(1); // ү is already u
  });

  it('adds a skeleton form only for words that mix Latin and Cyrillic letters', () => {
    const lookalike = '\u041d\u043e\u0440\u0440er'; // Cyrillic Н о р р + Latin e r: looks like "Hopper"
    const forms = normalizeNameForms(lookalike);
    expect(forms[0]).toBe('norer'); // phonetic: н→n р→r
    expect(forms).toContain('hoper'); // shape: Н→H р→p
    expect(normalizeNameForms('Нина')).toEqual(['nina']); // a purely Cyrillic word keeps the phonetic form only
    expect(normalizeNameForms('Pepsi')).toEqual(['pepsi']);
  });

  it('keeps every form distinct and non-empty', () => {
    for (const input of ['Өлзий', '\u041d\u043e\u0440\u0440er', 'Mixed \u043e\u0440 Өө', '---']) {
      const forms = normalizeNameForms(input);
      expect(new Set(forms).size).toBe(forms.length);
      expect(forms.slice(1).every((f) => f !== '')).toBe(true);
    }
  });
});

describe('joinTokens', () => {
  it('concatenates tokens without separators', () => {
    expect(joinTokens(['abdul', 'rahman'])).toBe('abdulrahman');
    expect(joinTokens([])).toBe('');
  });

  it('folds across the join boundary exactly like normalizeName of the space-less spelling', () => {
    expect(joinTokens(tokenize(normalizeName('Bat Tuvshin')))).toBe(normalizeName('Battuvshin'));
    expect(joinTokens(tokenize(normalizeName('Alp Hamza')))).toBe(normalizeName('Alphamza'));
    expect(joinTokens(tokenize(normalizeName('Mak Khan')))).toBe(normalizeName('Makkhan'));
  });
});

describe('tokenize', () => {
  it('splits a normalized name on spaces', () => {
    expect(tokenize('bat erdene ganbold')).toEqual(['bat', 'erdene', 'ganbold']);
  });

  it('returns a single token for a one-word name', () => {
    expect(tokenize('ganbold')).toEqual(['ganbold']);
  });

  it('returns an empty list for an empty or blank string', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });

  it('ignores repeated and surrounding spaces', () => {
    expect(tokenize('  bat   erdene ')).toEqual(['bat', 'erdene']);
  });

  it('composes with normalizeName', () => {
    expect(tokenize(normalizeName('Ganbold, Bat-Erdene'))).toEqual(['ganbold', 'bat', 'erdene']);
  });
});
