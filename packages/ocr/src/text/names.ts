// Нэр тулгах (BSA-FR-2.2 verifier: хуулгын эзэмшигчийн нэр ↔ харилцагч; BSA-FR-1.2). Үг бүрийг toMatchKey-ээр латин/кирилл
// хамааралгүй болгож, эрэмбэ үл хамааран зэрэгцүүлнэ. Эхний үсэг (Б.Болд), дэнслэл (Бат-Эрдэнэ) тэсвэрлэнэ.
import { INVISIBLE_CHARS_RE } from './charmap';
import { toMatchKey } from './match-key';

/** Нэр тулгалтын анхдагч утгууд — НЭГ газар (бизнесийн босго биш, параметр: opts.minScore-оор дарж болно) */
export const NAMES_MATCH_DEFAULTS = {
  /** match=true болох доод оноо */
  minScore: 0.8,
  /** Үгийн шивэлтийн алдааг тэсвэрлэх доод ижилсэл (1 - засварын зай / урт). 5 тэмдэгтэд 1 засвар = 0.8 */
  fuzzyTokenMinSimilarity: 0.8,
  /** Эхний үсэг ↔ бүтэн үгийн ижилсэл (яг таарсан бүтэн үгээс бага) */
  initialSimilarity: 0.9,
  /** Эхний үсгийн жин (бүтэн үг = 1): мэдээлэл багатай тул дутахад бага торгоно */
  initialWeight: 0.5,
  /** Оролтын дээд урт — хэтэрвэл нэр биш (DoS-оос хамгаална) */
  maxInputLength: 200,
  /** Засварын зай тооцох үгийн дээд урт */
  maxFuzzyTokenLength: 32,
} as const;

export interface NamesMatchOptions {
  minScore?: number;
}

export interface NameMatchResult {
  match: boolean;
  /** 0..1 (3 орон) */
  score: number;
}

interface NameToken {
  key: string;
  initial: boolean;
  weight: number;
}

const HYPHEN_BETWEEN_LETTERS_SRC = String.raw`(?<=[\p{L}\p{M}])[-\u2010\u2011\u2012\u2013\u2014](?=[\p{L}\p{M}])`;
const HYPHEN_BETWEEN_LETTERS_RE = new RegExp(HYPHEN_BETWEEN_LETTERS_SRC, 'gu'); // replace-д
const HAS_HYPHEN_RE = new RegExp(HYPHEN_BETWEEN_LETTERS_SRC, 'u'); // test-д (g-гүй: lastIndex төлөвгүй)
const NAME_SEPARATOR_RE = /[^\p{L}\p{M}\p{N}'\u2019\u02BC]+/u;

/** Нэрийг үгүүд болгоно. joinHyphens=true бол "Бат-Эрдэнэ" нэг үг, false бол хоёр үг. Цифр, хоосон түлхүүртэй үгийг орхино. */
function tokenize(name: string, joinHyphens: boolean): NameToken[] {
  let s = name.normalize('NFKC').replace(INVISIBLE_CHARS_RE, '');
  if (joinHyphens) s = s.replace(HYPHEN_BETWEEN_LETTERS_RE, '');
  const tokens: NameToken[] = [];
  for (const word of s.split(NAME_SEPARATOR_RE)) {
    if (word === '' || !/\p{L}/u.test(word)) continue;
    const key = toMatchKey(word);
    if (key === '') continue;
    const initial = Array.from(word.replace(/['\u2019\u02BC]/g, '')).length === 1;
    tokens.push({ key, initial, weight: initial ? NAMES_MATCH_DEFAULTS.initialWeight : 1 });
  }
  return tokens;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Хоёр үгийн ижилсэл 0..1; доод ижилслээс бага бол 0. */
function tokenSimilarity(a: NameToken, b: NameToken): number {
  if (a.initial && b.initial) return a.key === b.key ? 1 : 0;
  if (a.initial || b.initial) {
    const [short, full] = a.initial ? [a, b] : [b, a];
    return full.key.startsWith(short.key) ? NAMES_MATCH_DEFAULTS.initialSimilarity : 0;
  }
  if (a.key === b.key) return 1;
  const longest = Math.max(a.key.length, b.key.length);
  if (longest > NAMES_MATCH_DEFAULTS.maxFuzzyTokenLength) return 0;
  const sim = 1 - levenshtein(a.key, b.key) / longest;
  return sim >= NAMES_MATCH_DEFAULTS.fuzzyTokenMinSimilarity ? sim : 0;
}

/** Жинлэсэн Dice: 2·Σ(ижилсэл·хосын жин) / (A-ийн жин + B-ийн жин); үг бүр нэг л хостой (хомхой, тогтвортой). anchored = бүтэн үг ≥ 1 таарсан. */
function scoreTokens(a: NameToken[], b: NameToken[]): { score: number; anchored: boolean } {
  if (a.length === 0 || b.length === 0) return { score: 0, anchored: false };
  const pairs: Array<{ i: number; j: number; credit: number; full: boolean }> = [];
  a.forEach((ta, i) =>
    b.forEach((tb, j) => {
      const sim = tokenSimilarity(ta, tb);
      if (sim > 0) pairs.push({ i, j, credit: sim * ((ta.weight + tb.weight) / 2), full: !ta.initial && !tb.initial });
    }),
  );
  pairs.sort((x, y) => y.credit - x.credit || x.i - y.i || x.j - y.j);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  let total = 0;
  let anchored = false;
  for (const p of pairs) {
    if (usedA.has(p.i) || usedB.has(p.j)) continue;
    usedA.add(p.i);
    usedB.add(p.j);
    total += p.credit;
    if (p.full) anchored = true;
  }
  const weightSum = a.reduce((n, t) => n + t.weight, 0) + b.reduce((n, t) => n + t.weight, 0);
  return { score: Math.min(1, (2 * total) / weightSum), anchored };
}

/**
 * Хоёр нэр ижил хүнийх эсэх. Үг тус бүрийг toMatchKey-ээр хувиргана ('Болд' = 'Bold'), эрэмбэ үл хамаарна (овог/нэр солигдсон ч),
 * 'Б.Болд' ↔ 'Болд Батаа' (эхний үсэг = овгийн эхний үсэг) таарна, дэнслэл ('Бат-Эрдэнэ' ↔ 'Бат Эрдэнэ' ↔ 'Батэрдэнэ') тэсвэрлэнэ,
 * 5+ тэмдэгтийн үгэнд 1 шивэлтийн алдаа тэсвэрлэнэ. ЗАЙЛШГҮЙ нөхцөл: хамгийн багадаа нэг БҮТЭН үг таарах — зөвхөн эхний үсгүүд
 * таарахыг тохирол гэж үзэхгүй. Хоосон/хэт урт (> 200) оролт → { match: false, score: 0 }. Генитив ('Батын' ↔ 'Бат') тооцохгүй.
 */
export function namesMatch(a: string, b: string, opts: NamesMatchOptions = {}): NameMatchResult {
  const minScore = opts.minScore ?? NAMES_MATCH_DEFAULTS.minScore;
  const fail = { match: false, score: 0 };
  if (typeof a !== 'string' || typeof b !== 'string') return fail;
  if (a.length > NAMES_MATCH_DEFAULTS.maxInputLength || b.length > NAMES_MATCH_DEFAULTS.maxInputLength) return fail;

  const joinModes = (name: string): boolean[] => (HAS_HYPHEN_RE.test(name) ? [false, true] : [false]);
  const candidates: Array<{ score: number; ok: boolean }> = [];
  for (const joinA of joinModes(a)) {
    for (const joinB of joinModes(b)) {
      const r = scoreTokens(tokenize(a, joinA), tokenize(b, joinB));
      candidates.push({ score: r.score, ok: r.anchored && r.score + 1e-9 >= minScore });
    }
  }
  // Тохирсон хувилбар (ok) түрүүлнэ, дараа нь өндөр оноо
  const best = candidates.reduce((x, y) => ((y.ok && !x.ok) || (y.ok === x.ok && y.score > x.score) ? y : x));
  return { match: best.ok, score: Math.round(best.score * 1000) / 1000 };
}
