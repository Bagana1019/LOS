import { describe, expect, it } from 'vitest';
import { DEFAULT_AML_POLICY } from '@los/contracts';
import { jaroWinklerCodePoints } from './jaro-winkler';
import { bestNameMatch, bestPreparedMatch, DIGIT_CONFLICT_CAP, mayMatch, nameSimilarity, prepareName, VARIANT_SCORE_CAP, VOWEL_SCORE_CAP } from './name-similarity';

const { reviewThreshold, strongThreshold } = DEFAULT_AML_POLICY;

describe('nameSimilarity: cross-script', () => {
  it('Бат-Эрдэнэ Ганболд vs Bat Erdene Ganbold is a strong match', () => {
    expect(nameSimilarity('Бат-Эрдэнэ Ганболд', 'Bat Erdene Ganbold')).toBeGreaterThanOrEqual(strongThreshold);
  });

  it('Мөнхсайхан vs Munkhsaikhan >= 0.90', () => {
    expect(nameSimilarity('Мөнхсайхан', 'Munkhsaikhan')).toBeGreaterThanOrEqual(0.9);
  });

  it.each(['Bataa Ulzii', 'Bataa Olzii'])('Батаа Өлзий vs %s reaches the review threshold', (latin) => {
    expect(nameSimilarity('Батаа Өлзий', latin)).toBeGreaterThanOrEqual(reviewThreshold);
  });

  it('matches Latin against Cyrillic as well (vice versa)', () => {
    expect(nameSimilarity('Bat Erdene Ganbold', 'Бат-Эрдэнэ Ганболд')).toBeGreaterThanOrEqual(strongThreshold);
  });

  it('matches a Russian Cyrillic name against its Latin rendering', () => {
    expect(nameSimilarity('Александр Петров', 'Aleksandr Petrov')).toBeGreaterThanOrEqual(strongThreshold);
  });
});

describe('nameSimilarity: order and spelling variants', () => {
  it('is independent of token order', () => {
    expect(nameSimilarity('Ganbold Bat-Erdene', 'Bat-Erdene Ganbold')).toBe(1);
    expect(nameSimilarity('Ганболд Бат-Эрдэнэ', 'Bat Erdene Ganbold')).toBe(1);
  });

  it('tolerates Muhammad Al Rashid vs Mohammed Al-Rashid', () => {
    expect(nameSimilarity('Muhammad Al Rashid', 'Mohammed Al-Rashid')).toBeGreaterThanOrEqual(reviewThreshold);
  });

  it('tolerates Alexander Petrov vs Aleksandr Petrov', () => {
    expect(nameSimilarity('Alexander Petrov', 'Aleksandr Petrov')).toBeGreaterThanOrEqual(reviewThreshold);
  });

  it('treats case, punctuation and extra spaces as irrelevant', () => {
    expect(nameSimilarity('  BAT   erdene,  Ganbold ', 'bat-erdene ganbold')).toBe(1);
  });

  it('treats diacritics as irrelevant', () => {
    expect(nameSimilarity('José Álvarez', 'Jose Alvarez')).toBe(1);
  });

  it('returns 1 for names that normalize to the same string', () => {
    expect(nameSimilarity('Khalid', 'Halid')).toBe(1);
  });
});

describe('nameSimilarity: stays below the review threshold', () => {
  it.each([
    ['partial overlap: Bat Erdene vs Bat Erdene Ganbold', 'Bat Erdene', 'Bat Erdene Ganbold'],
    ['shared first name, different second name (Cyrillic)', 'Бат Болд', 'Бат Эрдэнэ'],
    ['same first name, different surname', 'Ivan Petrov', 'Ivan Sidorov'],
    ['similar one-token names', 'Ganbold', 'Ganbat'],
    ['unrelated names', 'Оюунчимэг Дашдорж', 'Fatima Hassan'],
    ['one-token query vs a long sanctioned name', 'Ganbold', 'Ganbold Batbayar Erdenebat Dorjsuren'],
    ['long sanctioned name vs one-token query', 'Abu Bakr Muhammad Al Rashid', 'Rashid'],
    ['same company name, different number', 'Монгол Трейд 88 ХХК', 'Монгол Трейд 99 ХХК'],
  ])('%s', (_label, a, b) => {
    expect(nameSimilarity(a, b)).toBeLessThan(reviewThreshold);
  });

  it('gives the real numbers for the documented partial-overlap case', () => {
    // (3 + 6) / (3 + 6 + 7)
    expect(nameSimilarity('Bat Erdene', 'Bat Erdene Ganbold')).toBeCloseTo(9 / 16, 10);
  });

  it('scores completely different names low', () => {
    expect(nameSimilarity('Оюунчимэг', 'Fatima')).toBeLessThan(0.3);
  });
});

describe('nameSimilarity: company names and digits', () => {
  it('keeps digits significant and equal company names equal', () => {
    expect(nameSimilarity('Монгол Трейд 88 ХХК', 'Монгол Трейд 88 ХХК')).toBe(1);
    expect(nameSimilarity('Монгол Трейд 88 ХХК', 'mongol treid 88 hhk')).toBe(1);
  });

  it('matches a single-token name against itself', () => {
    expect(nameSimilarity('Ганболд', 'Ganbold')).toBe(1);
  });
});

describe('nameSimilarity: edge cases', () => {
  it('returns 0 for empty, blank or punctuation-only input on either side', () => {
    expect(nameSimilarity('', 'Bat')).toBe(0);
    expect(nameSimilarity('Bat', '   ')).toBe(0);
    expect(nameSimilarity('---', '...')).toBe(0);
    expect(nameSimilarity('', '')).toBe(0);
  });

  it('is symmetric over a table of pairs', () => {
    const names = [
      'Бат-Эрдэнэ Ганболд', 'Bat Erdene Ganbold', 'Ganbold Bat-Erdene', 'Bat Erdene', 'Muhammad Al Rashid',
      'Mohammed Al-Rashid', 'Alexander Petrov', 'Aleksandr Petrov', 'Ivan Petrov', 'Ivan Sidorov', 'Ganbold',
      'Ganbat', 'Монгол Трейд 88 ХХК', 'José', 'Bat Bat Bat', 'Bat Bata Batu Bar', 'Б. Ганболд', '', '---',
      'Abdul Rahman', 'Abdulrahman', 'Батэрдэнэ Ганболд', 'Өлзий Мөнхөө', 'Ulzii Munkhuu', '\u041d\u043e\u0440\u0440er', 'Hopper',
    ];
    for (const a of names) {
      for (const b of names) {
        const score = nameSimilarity(a, b);
        expect(score, `${a} / ${b}`).toBe(nameSimilarity(b, a));
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('stays symmetric when equal-scoring token pairs compete for the same token', () => {
    // "bata"/"batu"/"bat" score equally against each other, so the greedy assignment has ties to break
    expect(nameSimilarity('Bata Batu Bat', 'Batu Bat Bata Bar')).toBe(nameSimilarity('Batu Bat Bata Bar', 'Bata Batu Bat'));
    expect(nameSimilarity('Bat Bat', 'Bat Bata Batu')).toBe(nameSimilarity('Bat Bata Batu', 'Bat Bat'));
  });

  it('counts a repeated token only as often as the other side has it', () => {
    expect(nameSimilarity('Bat Bat', 'Bat')).toBeLessThan(reviewThreshold);
  });

  it('finishes quickly on 1,000 character inputs', () => {
    const long = 'Бат-Эрдэнэ Ганболд '.repeat(53).slice(0, 1000);
    const other = 'Bat Erdene Dorj '.repeat(63).slice(0, 1000);
    const start = performance.now();
    const score = nameSimilarity(long, other);
    nameSimilarity('a'.repeat(1000), 'a'.repeat(999) + 'b');
    expect(performance.now() - start).toBeLessThan(1000);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('bestNameMatch', () => {
  it('returns the highest-scoring pair with the original (unnormalized) names', () => {
    const match = bestNameMatch(['Ганболд Бат-Эрдэнэ', 'Dorj'], ['Fatima Hassan', 'Bat Erdene Ganbold']);
    expect(match).toEqual({ score: 1, subjectName: 'Ганболд Бат-Эрдэнэ', candidateName: 'Bat Erdene Ganbold' });
  });

  it('considers aliases on both sides', () => {
    const match = bestNameMatch(['Unrelated Person', 'Мөнхсайхан'], ['Some Other Name', 'Munkhsaikhan']);
    expect(match?.subjectName).toBe('Мөнхсайхан');
    expect(match?.candidateName).toBe('Munkhsaikhan');
    expect(match?.score).toBeGreaterThanOrEqual(0.9);
  });

  it('returns null when either list is empty', () => {
    expect(bestNameMatch([], ['Bat'])).toBeNull();
    expect(bestNameMatch(['Bat'], [])).toBeNull();
    expect(bestNameMatch([], [])).toBeNull();
  });

  it('returns null when a list only contains blank or punctuation-only names', () => {
    expect(bestNameMatch(['', '  '], ['Bat'])).toBeNull();
    expect(bestNameMatch(['Bat'], ['---', '...'])).toBeNull();
  });

  it('skips blank entries next to real names', () => {
    expect(bestNameMatch(['', 'Bat Erdene'], ['  ', 'Bat Erdene'])).toEqual({ score: 1, subjectName: 'Bat Erdene', candidateName: 'Bat Erdene' });
  });

  it('returns a low-scoring pair (not null) for non-blank lists that share nothing', () => {
    expect(bestNameMatch(['Оюунчимэг'], ['Fatima'])?.score).toBeLessThan(0.3);
  });

  it('keeps the first pair when scores tie', () => {
    const match = bestNameMatch(['Bat Erdene', 'Бат Эрдэнэ'], ['bat-erdene', 'BAT ERDENE']);
    expect(match).toEqual({ score: 1, subjectName: 'Bat Erdene', candidateName: 'bat-erdene' });
  });

  it('agrees with nameSimilarity for a single pair', () => {
    const score = nameSimilarity('Muhammad Al Rashid', 'Mohammed Al-Rashid');
    expect(bestNameMatch(['Muhammad Al Rashid'], ['Mohammed Al-Rashid'])?.score).toBe(score);
  });
});

describe('nameSimilarity: joined vs split words (FR-13.1)', () => {
  it.each([
    ['Abdul Rahman', 'Abdulrahman'],
    ['Abu Bakr', 'Abubakr'],
    ['Bin Haidar', 'Binhaidar'],
    ['Enkh Tuvshin', 'Enkhtuvshin'],
    ['Бат-Эрдэнэ Ганболд', 'Батэрдэнэ Ганболд'],
    ['Бат-Эрдэнэ Ганболд', 'Baterdene Ganbold'],
    ['Abdul Rahman Al Saud', 'Abdulrahman Alsaud'],
    ['Abdul Rahman Al Saud', 'Abdulrahman Al Saud'],
  ])('%s ~ %s reaches the strong threshold', (a, b) => {
    expect(nameSimilarity(a, b)).toBeGreaterThanOrEqual(strongThreshold);
    expect(nameSimilarity(b, a)).toBe(nameSimilarity(a, b));
  });

  // овог-нэр / нэр-овог дараалал + нийлмэл нэрийн хил хязгаар хоёулаа зөрсөн (Монгол нэрэнд энгийн).
  // Нормчилсон нэр ИЖИЛ биш тул score 1 (NAME_EXACT) биш, харин VARIANT_SCORE_CAP (strongThreshold-оос дээш) — review [8].
  it('matches when the word order differs as well (patronymic-first vs given-name-first), below an exact match', () => {
    for (const [a, b] of [
      ['Ганболд Батэрдэнэ', 'Bat Erdene Ganbold'],
      ['Ganbold Baterdene', 'Bat-Erdene Ganbold'],
      ['Abdul Rahman Al Saud', 'Alsaud Abdulrahman'],
    ]) {
      expect(nameSimilarity(a, b), `${a} / ${b}`).toBe(VARIANT_SCORE_CAP);
      expect(nameSimilarity(b, a), `${b} / ${a}`).toBe(VARIANT_SCORE_CAP);
    }
    expect(VARIANT_SCORE_CAP).toBeGreaterThanOrEqual(strongThreshold);
    expect(VARIANT_SCORE_CAP).toBeLessThan(1);
    expect(nameSimilarity('Ганболд Батэрдэнэ', 'Dorj Bat Erdene Ganbold')).toBeLessThan(reviewThreshold);
  });

  it('tolerates a spelling variant on top of a word-boundary shift', () => {
    expect(nameSimilarity('Abdul Rahman Al Saud', 'Abdurrahman Alsaud')).toBeGreaterThanOrEqual(reviewThreshold);
    expect(nameSimilarity('Mohammed Abdul Rahim', 'Muhammad Abdulrahim')).toBeGreaterThanOrEqual(reviewThreshold);
  });

  it('folds across the join boundary (Bat Tuvshin ~ Battuvshin, Alp Hamza ~ Alphamza), as a joined match below 1', () => {
    expect(nameSimilarity('Bat Tuvshin', 'Battuvshin')).toBe(VARIANT_SCORE_CAP);
    expect(nameSimilarity('Alp Hamza', 'Alphamza')).toBe(VARIANT_SCORE_CAP);
  });

  it('does not turn a partial overlap into a match: the joined form is compared by edit distance, not Jaro-Winkler', () => {
    // joined "baterdene" vs "baterdeneganbold": Jaro-Winkler's prefix boost would give ~0.91
    expect(nameSimilarity('Bat Erdene', 'Bat Erdene Ganbold')).toBeCloseTo(9 / 16, 10);
    expect(nameSimilarity('Abdul Rahman', 'Abdul Rahman Al Saud')).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('Bat Erdene', 'Baterdene Ganbold')).toBeLessThan(reviewThreshold);
  });

  it('keeps different people apart even when the joined strings are similar', () => {
    expect(nameSimilarity('Ivan Petrov', 'Ivan Sidorov')).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('Ali Hassan', 'Ali Hussein Nasser')).toBeLessThan(reviewThreshold);
  });

  it('never joins across different digits (88 vs 99 are different companies)', () => {
    // залгасан хэлбэрийн засварын зай 2/29 (≈ 0.93) байх тул цифрийн шалгалтгүй бол review босгыг давна
    const a = 'Mongol Trade Holding Group 88 Alpha';
    const b = 'Mongol Trade Holding Group 99 Alpha';
    expect(nameSimilarity(a, b)).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('Монгол Трейд 88 ХХК', 'Монгол Трейд 99 ХХК')).toBeLessThan(reviewThreshold);
  });

  it('does not change single-token comparisons', () => {
    expect(nameSimilarity('Ganbold', 'Ganbat')).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('Ганболд', 'Ganbold')).toBe(1);
  });
});

describe('nameSimilarity: ө/ү rendered as u (passport form)', () => {
  it.each([
    ['Өлзий', 'Ulzii'],
    ['Өлзий', 'Olzii'],
    ['Өө', 'Uu'],
    ['Өө', 'Oo'],
    ['Өлзий Мөнхөө', 'Ulzii Munkhuu'],
    ['Өлзий Мөнхөө', 'Olzii Monkhoo'],
    ['Өнөрбаяр Мөнхтөр', 'Unurbayar Munkhtur'],
  ])('%s ~ %s is an exact match', (cyrillic, latin) => {
    expect(nameSimilarity(cyrillic, latin)).toBe(1);
    expect(nameSimilarity(latin, cyrillic)).toBe(1);
  });

  // JW-ийн тэсвэрлэлтээр л таардаг байсан: хоёр ө-тэй токен, богино токен бүрэн алдагддаг
  it('matches names with several ө per token, which Jaro-Winkler tolerance alone could not', () => {
    const before = jaroWinklerCodePoints([...'monho'], [...'munhu']);
    expect(before).toBeLessThan(0.8);
    expect(nameSimilarity('Өлзий Мөнхөө', 'Ulzii Munkhuu')).toBeGreaterThanOrEqual(strongThreshold);
  });

  it('still keeps different names apart', () => {
    expect(nameSimilarity('Өлзий', 'Ulan')).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('Өлзий Бат', 'Ulzii Dorj')).toBeLessThan(reviewThreshold);
  });
});

describe('nameSimilarity: mixed-script homoglyphs', () => {
  // Кирилл Н, о, р, р + латин e, r: "Hopper"-тэй дүрсээр адил; дуудлагаар "norer" (р→r, н→n) болж алддаг байсан
  const lookalike = '\u041d\u043e\u0440\u0440er';
  it('scores the confusable skeleton as well and takes the maximum', () => {
    expect(nameSimilarity(lookalike, 'Hopper')).toBe(1);
    expect(nameSimilarity('Hopper', lookalike)).toBe(1);
    expect(nameSimilarity(`${lookalike} Smith`, 'Hopper Smith')).toBe(1);
  });

  it('a purely Cyrillic name keeps its phonetic reading', () => {
    expect(nameSimilarity('Нина', 'Nina')).toBe(1);
    expect(nameSimilarity('Хүрэлсүх', 'Khurelsukh')).toBe(1);
  });

  it('does not make unrelated names similar', () => {
    expect(nameSimilarity(lookalike, 'Kowalski')).toBeLessThan(reviewThreshold);
  });
});

describe('nameSimilarity: legal entities', () => {
  const entity = { legalEntity: true };

  it('ignores the legal form (ХХК, LLC, Ltd, Co …) on either side', () => {
    expect(nameSimilarity('Altan ХХК', 'Altan LLC', entity)).toBe(1);
    expect(nameSimilarity('Монгол Трейд ХХК', 'Mongol Treid', entity)).toBe(1);
    expect(nameSimilarity('Монгол Трейд ХК', 'Mongol Treid Limited', entity)).toBe(1);
    expect(nameSimilarity('Zalvor Maritime Holdings Ltd', 'Zalvor Maritime Holdings Co', entity)).toBe(1);
    expect(nameSimilarity('Altanvex Fixture Trading LLC', 'Altanvex Fixture Trading', entity)).toBe(1);
  });

  it('without the entity option the designator is an ordinary word (people are not affected)', () => {
    expect(nameSimilarity('Altan ХХК', 'Altan LLC')).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('Монгол Трейд ХХК', 'Mongol Treid')).toBeLessThan(reviewThreshold);
  });

  it('still tells different companies apart and keeps numbers significant', () => {
    expect(nameSimilarity('Altanvex Trading ХХК', 'Zalvor Trading LLC', entity)).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('Монгол Трейд 88 ХХК', 'Монгол Трейд 99 ХХК', entity)).toBeLessThan(reviewThreshold);
  });

  it('falls back to the unstripped name when only legal forms are left', () => {
    expect(nameSimilarity('ХХК', 'ХК', entity)).toBe(1); // ХХК ~ ХК
    expect(nameSimilarity('ХХК', 'LLC', entity)).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('ХХК', 'Bat', entity)).toBeLessThan(reviewThreshold);
    expect(prepareName('ХХК', entity).forms).toHaveLength(1);
  });

  it('strips from bestNameMatch as well', () => {
    expect(bestNameMatch(['Altan ХХК'], ['Altan LLC'], entity)?.score).toBe(1);
    expect(bestNameMatch(['Altan ХХК'], ['Altan LLC'])?.score).toBeLessThan(reviewThreshold);
  });
});

describe('prepareName / bestPreparedMatch', () => {
  it('yields no forms for names that normalise to nothing', () => {
    for (const name of ['', '   ', '---', '\u200b', '😀']) expect(prepareName(name).forms, JSON.stringify(name)).toEqual([]);
  });

  it('bestPreparedMatch agrees with bestNameMatch and reuses prepared names', () => {
    const subjects = ['Ганболд Бат-Эрдэнэ', 'Dorj'];
    const candidates = ['Fatima Hassan', 'Bat Erdene Ganbold'];
    const prepared = bestPreparedMatch(subjects.map((n) => prepareName(n)), candidates.map((n) => prepareName(n)));
    expect(prepared).toEqual(bestNameMatch(subjects, candidates));
    expect(prepared).toEqual({ score: 1, subjectName: 'Ганболд Бат-Эрдэнэ', candidateName: 'Bat Erdene Ganbold' });
    // нэг бэлтгэсэн нэрийг олон удаа харьцуулж болно
    const once = prepareName('Bat Erdene Ganbold');
    expect(bestPreparedMatch([prepareName('Бат-Эрдэнэ Ганболд')], [once])?.score).toBe(1);
    expect(bestPreparedMatch([prepareName('Мөнхсайхан')], [once])?.score).toBeLessThan(0.5);
  });

  it('skips unscreenable names and returns null when nothing is left', () => {
    expect(bestPreparedMatch([prepareName('---')], [prepareName('Bat')])).toBeNull();
    expect(bestPreparedMatch([prepareName('Bat')], [])).toBeNull();
  });
});

describe('mayMatch prefilter never rejects a pair that Jaro-Winkler would accept', () => {
  const token = (text: string) => {
    const chars = [...text];
    let mask = 0;
    for (const ch of chars) mask |= 1 << (ch.codePointAt(0)! % 31);
    return { chars, mask };
  };

  it('rejects only pairs with JW < 0.8 over exhaustive short strings on a small alphabet', () => {
    const alphabet = ['a', 'b', 'c'];
    const words: string[] = [];
    const build = (prefix: string, depth: number) => {
      if (prefix) words.push(prefix);
      if (depth === 0) return;
      for (const ch of alphabet) build(prefix + ch, depth - 1);
    };
    build('', 5);
    let rejected = 0;
    for (const a of words) {
      for (const b of words) {
        if (mayMatch(token(a), token(b))) continue;
        rejected++;
        expect(jaroWinklerCodePoints([...a], [...b]), `${a} / ${b}`).toBeLessThan(0.8 - 1e-9);
      }
    }
    expect(rejected).toBeGreaterThan(0);
  });

  it('rejects only pairs with JW < 0.8 over random longer strings, including length ratios near 1/10', () => {
    let seed = 11;
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const random = (len: number, alphabet: string) => Array.from({ length: len }, () => alphabet[next(alphabet.length)]).join('');
    let rejected = 0;
    for (let i = 0; i < 4000; i++) {
      const alphabet = ['ab', 'abcdef', 'abcdefghijklmnopqrstuvwxyz'][next(3)];
      const a = random(1 + next(3), alphabet);
      const b = random(1 + next(30), alphabet);
      for (const [x, y] of [[a, b], [b, a]]) {
        if (mayMatch(token(x), token(y))) continue;
        rejected++;
        expect(jaroWinklerCodePoints([...x], [...y]), `${x} / ${y}`).toBeLessThan(0.8 - 1e-9);
      }
    }
    expect(rejected).toBeGreaterThan(100);
  });

  it('keeps the boundary pairs: JW("b", "bat") = 0.8 and 1:3 length ratios pass', () => {
    expect(mayMatch(token('b'), token('bat'))).toBe(true);
    expect(mayMatch(token('a'), token('abcdefghij'))).toBe(false); // 1:10 -> JW at most 0.7
    expect(mayMatch(token('a'), token('abcdefghi'))).toBe(true);
  });
});

// ── Review round 2 ───────────────────────────────────────────────────────────────────────────────────────────────

describe('nameSimilarity: Latin letters outside NFKD (review [2])', () => {
  it.each([
    ['Kılıç', 'Kilic'],
    ['Kılıç', 'KILIÇ'],
    ['Mehmet Yıldırım', 'Mehmet Yildirim'],
    ['Đỗ Đình Đạt', 'Do Dinh Dat'],
    ['Nguyễn Văn Đức', 'Nguyen Van Duc'],
    ['Łukasz', 'Lukasz'],
    ['Bjørn Ærø', 'Bjorn Aero'],
    ['Þórður Ðóra', 'Thordur Dora'],
    ['Straße', 'Strasse'],
    ['Œuvre', 'Oeuvre'],
  ])('%s ~ %s is an exact match in both directions', (a, b) => {
    expect(nameSimilarity(a, b)).toBe(1);
    expect(nameSimilarity(b, a)).toBe(1);
  });
});

describe('nameSimilarity: zh and j agree (review [7])', () => {
  it.each([
    ['Жаргал', 'Zhargal'],
    ['Жуков', 'Zhukov'],
    ['Жанар', 'Zhanar'],
    ['Жданов', 'Zhdanov'],
    ['Дорж', 'Dorzh'],
    ['Жанибек', 'Zhanibek'],
  ])('%s ~ %s is an exact match', (cyrillic, latin) => {
    expect(nameSimilarity(cyrillic, latin)).toBe(1);
    expect(nameSimilarity(latin, cyrillic)).toBe(1);
  });

  it('keeps a Kazakh spelling variant above the review threshold', () => {
    expect(nameSimilarity('Жумабаев', 'Zhumabayev')).toBeGreaterThanOrEqual(reviewThreshold);
  });
});

describe('nameSimilarity: o/u and e/a vowel variants (review [3])', () => {
  it.each([
    ['Mohammed Omar', 'Muhammad Umar'],
    ['Mohammed Khan', 'Muhammad Khan'],
    ['Mohammed Said', 'Muhammad Saeed'],
    ['Abdul Rahman Mohammed Khalid', 'Abd al-Rahman Muhammad Khalid'],
    ['Hossein', 'Hussein'],
    ['Muhammad', 'Mohammed'],
  ])('%s ~ %s reaches the review threshold, in both directions', (a, b) => {
    expect(nameSimilarity(a, b)).toBeGreaterThanOrEqual(reviewThreshold);
    expect(nameSimilarity(b, a)).toBe(nameSimilarity(a, b));
  });

  it('never reports a vowel variant as exact or strong, so a birth-year mismatch still drops it', () => {
    expect(nameSimilarity('Mohammed Omar', 'Muhammad Umar')).toBe(VOWEL_SCORE_CAP);
    expect(VOWEL_SCORE_CAP).toBeGreaterThanOrEqual(reviewThreshold);
    expect(VOWEL_SCORE_CAP).toBeLessThan(strongThreshold);
  });

  it('is an additional form: it never replaces the main form, and identical names stay at 1', () => {
    expect(nameSimilarity('Mohammed Omar', 'Mohammed Omar')).toBe(1);
    expect(nameSimilarity('Bat Erdene', 'bat-erdene')).toBe(1);
    // эгшгийн хувилбар нь ө→u (паспорт) хэлбэртэй хамт ажиллана
    expect(nameSimilarity('Өлзий', 'Ulzii')).toBe(1);
  });

  it('does not make different people similar', () => {
    for (const [a, b] of [['Ivan Petrov', 'Ivan Sidorov'], ['Bat Erdene', 'Bat Ochir'], ['Tolga Bold', 'Tulga Dorj'], ['Omar Ali', 'Umar Hassan']]) {
      expect(nameSimilarity(a, b), `${a} / ${b}`).toBeLessThan(reviewThreshold);
    }
  });

  it('prepares the vowel set only when the name has an o or e', () => {
    const withVowels = prepareName('Mohammed Omar');
    expect(withVowels.sets[1]).not.toBe(withVowels.sets[0]);
    expect(withVowels.sets[1][0].normalized).toBe('muhamad umar');
    const without = prepareName('Bat Tuvshin');
    expect(without.sets[1]).toBe(without.sets[0]);
  });
});

describe('nameSimilarity: joined form only for word-boundary shifts (review [4])', () => {
  it.each([
    ['Malik bin Majid bin Umar al-Sabah', 'Nasir bin Majid bin Umar al-Sabah'],
    ['Salim bin Omar bin Kamal al-Qahtani', 'Walid bin Omar bin Kamal al-Qahtani'],
    ['Б.Ганбаатар', 'Д.Ганбаатар'],
    ['Б.Батбаяр', 'Д.Батбаяр'],
    ['Ж.Сүхбаатар', 'Д.Сүхбаатар'],
  ])('siblings and different initials stay apart: %s ~ %s', (a, b) => {
    expect(nameSimilarity(a, b)).toBeLessThan(reviewThreshold);
    expect(nameSimilarity(b, a)).toBeLessThan(reviewThreshold);
  });

  it('keeps the same-initial and merged-word cases', () => {
    expect(nameSimilarity('Б.Ганбаатар', 'Б.Ганбаатар')).toBe(1);
    expect(nameSimilarity('Abdul Rahman', 'Abdulrahman')).toBe(VARIANT_SCORE_CAP);
    expect(nameSimilarity('Бат-Эрдэнэ', 'Батэрдэнэ')).toBe(VARIANT_SCORE_CAP);
    expect(nameSimilarity('Bat​Erdene', 'Bat Erdene')).toBe(VARIANT_SCORE_CAP);
  });

  it('tolerates exactly one edit inside a boundary shift, scored 1 - edits / length', () => {
    // 'abdulrahmanalsaud' (17) vs 'abdurahmanalsaud' (16): 1 засвар
    expect(nameSimilarity('Abdul Rahman Al Saud', 'Abdurrahman Alsaud')).toBeCloseTo(1 - 1 / 17, 10);
    expect(nameSimilarity('Jor Tolkiem', 'Jortolkien')).toBeCloseTo(0.9, 10);
  });

  it('rejects two edits inside a boundary shift', () => {
    // 'abdulrahmanalsaud' vs 'abdurahmenalsaud': 2 засвар (эгшгийн хувилбарт эгшиг нь нэг болдог тул өөр эгшиг сонгосон)
    expect(nameSimilarity('Abdul Rahman Al Saud', 'Abdurahmin Alsaud')).toBeLessThan(reviewThreshold);
  });

  it('allows no edit when either name has an initial, but still merges initials into one word', () => {
    expect(nameSimilarity('J R Tolkiem', 'JR Tolkien')).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('Jor Tolkiem', 'Jortolkien')).toBeGreaterThanOrEqual(reviewThreshold); // initialгүй адил бүтэц
    expect(nameSimilarity('J R R Tolkien', 'JRR Tolkien')).toBe(VARIANT_SCORE_CAP);
  });

  it('requires every other token to match exactly', () => {
    // 'Bat Erdene Ganbold' ~ 'Baterdene Ganbolt': үлдсэн токен ганц тэмдэгтээр зөрсөн, хил хязгаарын шилжилт биш ч токен зам барьж авна
    expect(nameSimilarity('Bat Erdene Ganbold', 'Baterdene Ganbolt')).toBeLessThan(VARIANT_SCORE_CAP);
    // Abdul Latif ~ Abdul Atif: ганц токен бүхлээрээ өөр, залгах хилээр fold хийгдсэн тэнцэл хүчинтэй биш
    expect(nameSimilarity('Abdul Latif', 'Abdul Atif')).toBeLessThan(1);
  });

  // Mutation шалгалт: "хоосон хэсэг зөвшөөрөх" хувилбарт тест ногоон хэвээр байсан
  it('an extra word at either end is not a boundary shift (nothing is merged), even when the join fold hides a letter', () => {
    // 'ganbatar' + 'ra' → 'ganbatara' нь 'ganbatar'-аас 1 засвар (0.889) боловч нэмэлт үг нь хил хязгаарын шилжилт биш: токен замын 0.8
    expect(nameSimilarity('Ganbaatar', 'Ganbaatar Ra')).toBeCloseTo(0.8, 10);
    expect(nameSimilarity('Ganbaatar Ra', 'Ganbaatar')).toBeCloseTo(0.8, 10);
    expect(nameSimilarity('Altan', 'Altan Nu')).toBeLessThan(reviewThreshold);
  });

  it('an initial inside the shifted region blocks the join whichever side it is on', () => {
    // joined 'jrtolkien' хоёр талд яг тэнцүү боловч 'J R' нь нэг үг ('JR') болж нийлээгүй, нөгөө тал 'Tol Kien' гэж хоёр үг
    expect(nameSimilarity('J R Tolkien', 'JR Tol Kien')).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('JR Tol Kien', 'J R Tolkien')).toBeLessThan(reviewThreshold);
  });

  it('a digit that differs inside a token cannot be hidden by the joined form', () => {
    // joined 'alfa88baterdene' ~ 'alfa89baterdene' нь 1 засвар (0.93) боловч цифр зөрсөн: өөр нэр
    expect(nameSimilarity('Alfa88 Bat Erdene', 'Alfa89 Baterdene')).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('Alfa89 Baterdene', 'Alfa88 Bat Erdene')).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('Alfa88 Bat Erdene', 'Alfa88 Baterdene')).toBe(VARIANT_SCORE_CAP);
  });
});

describe('nameSimilarity: a rotation or a joined match is never exact (review [8])', () => {
  it.each([
    ['Evans S', 'Evans E'],
    ['Hill L', 'Hill K'],
    ['Hall L', 'K Hall'],
    ['H H', 'H K'],
    ['Li Na', 'Lin A'],
    ['Abdul Latif', 'Abdul Atif'],
  ])('%s ~ %s is not an exact match', (a, b) => {
    expect(nameSimilarity(a, b)).toBeLessThan(1);
    expect(nameSimilarity(b, a)).toBeLessThan(1);
  });

  it.each([
    ['Evans S', 'Evans E'],
    ['Hill L', 'Hill K'],
    ['Hall L', 'K Hall'],
    ['H H', 'H K'],
    ['Li Na', 'Lin A'],
  ])('%s ~ %s is not even a review-level match: an initial never takes part in a rotation', (a, b) => {
    expect(nameSimilarity(a, b)).toBeLessThan(reviewThreshold);
  });

  it('Ma Li ~ Mali is a joined match, but below 1', () => {
    expect(nameSimilarity('Ma Li', 'Mali')).toBe(VARIANT_SCORE_CAP);
  });

  it('never returns exactly 1 unless the normalised names (or their token sets) are identical', () => {
    const names = [
      'Ма Ли', 'Mali', 'Ma Li', 'Li Na', 'Lina', 'Lin A', 'Evans S', 'Evans E', 'Abdul Rahman', 'Abdulrahman', 'Abdul Latif', 'Abdul Atif',
      'Ганболд Батэрдэнэ', 'Bat Erdene Ganbold', 'Baterdene Ganbold', 'Bat Tuvshin', 'Battuvshin', 'Alp Hamza', 'Alphamza', 'Hill L', 'Hill K', 'K Hill',
    ];
    for (const a of names) {
      for (const b of names) {
        const score = nameSimilarity(a, b);
        const sameTokens = prepareName(a).forms[0].tokens.map((t) => t.text).sort().join(' ') === prepareName(b).forms[0].tokens.map((t) => t.text).sort().join(' ');
        if (!sameTokens) expect(score, `${a} / ${b}`).toBeLessThan(1);
      }
    }
  });
});

describe('nameSimilarity: legal forms in entity names (review [6], [9])', () => {
  const entity = { legalEntity: true };

  it.each([
    ['Al Noor Trading L.L.C.', 'Al Noor Trading LLC'],
    ['Al Noor Trading L.L.C.', 'Al Noor Trading'],
    ['Al Noor Trading L. L. C.', 'Al Noor Trading Ltd'],
    ['Zorya Shipping F.Z.E.', 'Zorya Shipping FZE'],
    ['Zorya Shipping P.J.S.C.', 'Zorya Shipping JSC'],
    ['Zorya Shipping Pvt. Ltd.', 'Zorya Shipping'],
    ['Zorya Shipping S.A.R.L.', 'Zorya Shipping SARL'],
    ['Zorya Shipping SRL', 'Zorya Shipping'],
    ['Алтан Х.Х.К', 'Altan LLC'],
    ['ООО Ромашка', 'Romashka LLC'],
    ['OOO Romashka', 'Romashka'],
    ['ЗАО Ромашка', 'Romashka CJSC'],
    ['ОАО Ромашка', 'Romashka OJSC'],
  ])('%s ~ %s is an exact match for an entity', (a, b) => {
    expect(nameSimilarity(a, b, entity)).toBe(1);
    expect(nameSimilarity(b, a, entity)).toBe(1);
  });

  it('does not strip or collapse anything for a person', () => {
    expect(nameSimilarity('Al Noor Trading L.L.C.', 'Al Noor Trading')).toBeLessThan(reviewThreshold);
    expect(nameSimilarity('Altan LLC', 'Altan')).toBeLessThan(reviewThreshold);
  });

  it('a standalone letter o is not treated as a legal form (OOO is rewritten to LLC, not stripped as "o")', () => {
    expect(nameSimilarity('Zorya O', 'Zorya', entity)).toBeLessThan(1);
  });

  it('comparing without stripping can only add recall: a typo next to a shared designator keeps its old score', () => {
    // Golomt/Gmlomt: designatorгүй 0.84-д унадаг байсан (устгасан нэр богино тул нэг үсгийн алдаа их), designator-той нь 0.88
    for (const [a, b] of [['Golomt ХХК', 'Gmlomt ХХК'], ['Golomt Co', 'Gclomt Co'], ['Golomt Co', 'Gxlomt Co'], ['Ming Tai ХК', 'Mxng Tai ХК']]) {
      expect(nameSimilarity(a, b, entity), `${a} / ${b}`).toBeGreaterThanOrEqual(nameSimilarity(a, b));
      expect(nameSimilarity(a, b, entity), `${a} / ${b}`).toBeGreaterThanOrEqual(reviewThreshold);
    }
  });

  it('prepares an unstripped set only when stripping changed something', () => {
    const stripped = prepareName('Altan LLC', entity);
    expect(stripped.sets[0][0].normalized).toBe('altan');
    expect(stripped.sets[2][0].normalized).toBe('altan lc');
    const plain = prepareName('Altan Trading', entity);
    expect(plain.sets[2]).toBe(plain.sets[0]);
    // хувь хүнд хасалт байхгүй: хуулийн хэлбэр жирийн токен хэвээр
    const person = prepareName('Altan LLC');
    expect(person.forms[0].normalized).toBe('altan lc');
    expect(person.sets[2]).toBe(person.sets[0]);
  });

  // Хасаагүй хэлбэрт эгшгийн хувилбар нэмбэл Co/Inc токен залгах хилээр fold хийгдэж "Hossein Co" ~ "Moussa Inc"-ийг 0.909 болгодог байсан
  it('has exactly three sets, and no vowel variant of the unstripped form', () => {
    expect(prepareName('Mohammed LLC', entity).sets).toHaveLength(3);
    expect(prepareName('', entity).sets).toHaveLength(3);
    for (const [a, b] of [['Hossein Co Omar', 'Moussa Inc Omar'], ['Hossein Company', 'Moussa Inc Company'], ['Mohammed Co Op', 'Muhammad Corp']]) {
      expect(nameSimilarity(a, b, entity), `${a} / ${b}`).toBeLessThan(reviewThreshold);
      expect(nameSimilarity(b, a, entity), `${b} / ${a}`).toBeLessThan(reviewThreshold);
    }
  });

  it('keeps the vowel variant for the stripped form of an entity', () => {
    expect(nameSimilarity('Mohammed Trading LLC', 'Muhammad Trading Ltd', entity)).toBe(VOWEL_SCORE_CAP);
  });
});

describe('nameSimilarity: numbered entities (review [12])', () => {
  const entity = { legalEntity: true };
  const group = (n: string) => `Altan Gobi Mining Holdings Group ${n} LLC`;

  it.each([['1', '2'], ['18', '81'], ['88', '8'], ['8', '88'], ['2024', '2025']])('Group %s ~ Group %s stays below the review threshold', (a, b) => {
    expect(nameSimilarity(group(a), group(b), entity)).toBeLessThan(reviewThreshold);
    expect(nameSimilarity(group(b), group(a), entity)).toBeLessThan(reviewThreshold);
    expect(nameSimilarity(group(a), group(b), entity)).toBe(DIGIT_CONFLICT_CAP);
  });

  it('applies to people and companies alike, and only when both names have a digit token', () => {
    expect(nameSimilarity('Altan Group 1', 'Altan Group 2')).toBe(DIGIT_CONFLICT_CAP);
    expect(nameSimilarity(group('1'), group('1'), entity)).toBe(1);
    expect(nameSimilarity('Altan Gobi Mining Holdings Group 1', 'Altan Gobi Mining Holdings Group', entity)).toBeGreaterThanOrEqual(reviewThreshold);
    // цифрийн олонлог ижил бол дараалал хамаарахгүй
    expect(nameSimilarity('Fund 12 Alpha 7', 'Alpha 7 Fund 12')).toBe(1);
  });

  it('counts digits of every script, not only 0-9 (Arabic-Indic, Devanagari)', () => {
    expect(nameSimilarity('Group ١ Alpha Bravo Charlie', 'Group ٢ Alpha Bravo Charlie')).toBe(DIGIT_CONFLICT_CAP);
    expect(nameSimilarity('Group १ Alpha Bravo Charlie', 'Group २ Alpha Bravo Charlie')).toBe(DIGIT_CONFLICT_CAP);
    expect(nameSimilarity('Group ١ Alpha Bravo Charlie', 'Group ١ Alpha Bravo Charlie')).toBe(1);
  });

  it('compares the digit tokens as a sorted multiset, so word order does not matter', () => {
    // 12 ба 7 эрэмбэлэгдсэн: [12, 7] ≡ [7, 12]
    expect(nameSimilarity('Fund 12 Alpha 7 Delta', 'Fund 7 Alpha 12 Delta')).toBeGreaterThan(DIGIT_CONFLICT_CAP);
  });

  it('caps at the given ceiling (the engine passes a value just below the policy review threshold)', () => {
    expect(nameSimilarity(group('1'), group('2'), { ...entity, digitConflictCap: 0.2 })).toBe(0.2);
    expect(nameSimilarity(group('1'), group('2'), { ...entity, digitConflictCap: 0.8799 })).toBe(0.8799);
    // дээд хязгаар нь бодит оноог ДЭЭШЛҮҮЛЭХГҮЙ
    expect(nameSimilarity('Bat Erdene 1', 'Bat Erdene 2', { digitConflictCap: 0.99 })).toBeLessThan(0.99);
  });
});

describe('matching constants (review [35])', () => {
  const single = (a: string, b: string) => nameSimilarity(a, b);

  it('PAIR_MIN: a token pair counts from Jaro-Winkler 0.80, not below', () => {
    expect(jaroWinklerCodePoints([...'abcde'], [...'abcxyz'])).toBeCloseTo(0.79, 10);
    expect(single('abcde', 'abcxyz')).toBe(0);
    expect(jaroWinklerCodePoints([...'batbayar'], [...'batu'])).toBeCloseTo(0.7958, 4);
    expect(single('batbayar', 'batu')).toBe(0);
    // JW('b', 'bat') = 0.8 (0.7999999999999999 floating-point): epsilon-гүй бол энэ хос тоологдохгүй
    expect(single('Bat', 'B')).toBeCloseTo(0.8, 9);
    expect(single('Bat', 'B')).toBeGreaterThanOrEqual(0.8 - 1e-9);
  });

  it('JOINED_MIN: the joined form needs at least 0.80 (1 - 1 / 5), 0.75 on 4 letters is dropped', () => {
    // joined 'abcd' ~ 'abcz' = 0.75 → drop; токен зам: 'ab' ~ 'abcz' + 'cd' → 0.5778
    expect(single('ab cd', 'abcz')).toBeCloseTo(0.5778, 4);
    // joined 'abcdi' ~ 'abcdk' = 0.8 → keep
    expect(single('ab cdi', 'abcdk')).toBeCloseTo(0.8, 10);
  });

  it('JOINED edit budget: one edit, and none when an initial is involved', () => {
    expect(single('Abdul Rahman Al Saud', 'Abdurrahman Alsaud')).toBeGreaterThan(0.9);
    expect(single('A Abdul Rahman Al Saud', 'A Abdurrahman Alsaud')).toBeLessThan(reviewThreshold);
  });

  it('rotation needs at least two words on BOTH sides', () => {
    // 'erdenebat' нь 'Bat Erdene'-ийн эргэлт; нэг талд 1 токен байвал эргэлт хэрэглэгдэхгүй
    expect(single('Bat Erdene', 'Erdenebat')).toBeLessThan(reviewThreshold);
    expect(single('Bat Erdene', 'Erdene Bat')).toBe(1);
    expect(single('Ganbold Bat Erdene', 'Bat Erdene Ganbold')).toBe(1);
  });

  it('rotation: the pure unrotated joined equality of different token splits is not a rotation match', () => {
    // 'abdullatif' → 'abdulatif' fold хийгдэж 'Abdul Atif'-тэй таардаг байсан
    expect(single('Abdul Latif', 'Abdul Atif')).toBeLessThan(1);
    expect(single('Abdul Latif', 'Abdul Atif')).toBeCloseTo(0.9667, 4);
  });
});
