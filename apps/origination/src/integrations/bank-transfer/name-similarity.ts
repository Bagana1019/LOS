// FR-12.4: банкны дансны эзэмшигчийн нэр харьцуулалт. Кирилл Ө/Ү нь О/У-аас ӨӨР үсэг тул нормчлохдоо хутгахгүй.
export const NAME_MATCH_THRESHOLD = 0.85;

/** NFC → жижиг үсэг → үсэг/цифрээс бусдыг зай болгох → зайг нэгтгэх. Ө/Ү-г О/У болгохгүй. */
export function normalizeName(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('mn').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Levenshtein зай (code point-оор). */
export function levenshtein(a: string, b: string): number {
  const x = [...a]; const y = [...b];
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

export function levenshteinRatio(a: string, b: string): number {
  const len = Math.max([...a].length, [...b].length);
  return len === 0 ? 0 : 1 - levenshtein(a, b) / len;
}

/** Sørensen–Dice коэффициент (bigram). */
export function diceCoefficient(a: string, b: string): number {
  const grams = (s: string) => { const c = [...s]; const m = new Map<string, number>(); for (let i = 0; i < c.length - 1; i++) { const g = c[i] + c[i + 1]; m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const ga = grams(a); const gb = grams(b);
  const total = [...ga.values()].reduce((s, n) => s + n, 0) + [...gb.values()].reduce((s, n) => s + n, 0);
  if (total === 0) return a === b && a.length > 0 ? 1 : 0;
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return (2 * overlap) / total;
}

const sortTokens = (s: string) => s.split(' ').filter(Boolean).sort().join(' ');

/**
 * 0..1. Нормчилсон нэрийг (мөн үгийн дарааллыг эрэмбэлсэн хувилбарыг) Levenshtein ба Dice-аар харьцуулж хамгийн өндрийг авна —
 * "Бат Дорж" ба "Дорж Бат" ижил; "Өлзий" ба "Олзий" ялгаатай. Аль нэг нь хоосон бол 0.
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a); const nb = normalizeName(b);
  if (!na || !nb) return 0;
  const sa = sortTokens(na); const sb = sortTokens(nb);
  const best = Math.max(levenshteinRatio(na, nb), diceCoefficient(na, nb), levenshteinRatio(sa, sb), diceCoefficient(sa, sb));
  return Math.round(best * 10_000) / 10_000;
}

export const isNameMatch = (similarity: number) => similarity >= NAME_MATCH_THRESHOLD;
