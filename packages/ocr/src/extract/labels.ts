// Шошго (label) таних: OCR-ийн шуугианд тэсвэртэй (toMatchKey + бага засварын зай). Мөр бүрээс шошгын "цохилт" олж,
// утгыг ТУХАЙН МӨРӨНД шошгоны дараа, эсвэл ДАРААГИЙН МӨРӨНД (багана мэдэрч) авна.
import { toMatchKey } from '../text';
import { EXTRACT_DEFAULTS } from './defaults';
import type { DocLine, OcrDoc } from './doc';

export interface LabelDef {
  field: string;
  labels: readonly string[];
}

interface CompiledLabel {
  field: string;
  label: string;
  key: string;
  maxDist: number;
}

export interface LabelHit {
  field: string;
  lineIdx: number;
  /** глобал offset [start, end) */
  start: number;
  end: number;
  tokenCount: number;
  distance: number;
}

export interface ValueCandidate {
  hit: LabelHit;
  /** глобал offset [start, end) — шошгоны дараах утгын хэсэг */
  start: number;
  end: number;
  source: 'same-line' | 'next-line';
}

/** Шошгын нэг үгийн дээд урт — үүнээс урт токен шошго биш */
const MAX_LABEL_TOKEN_LENGTH = 40;
const TOKEN_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/** Засварын зайн дээд хэмжээ: ≤3 тэмдэгт = яг; бусад = урт/6 (доод тал нь 1) */
export const maxLabelDistance = (len: number): number => (len <= 3 ? 0 : Math.max(1, Math.floor(len / 6)));

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

const compiledCache = new WeakMap<readonly LabelDef[], CompiledLabel[]>();
function compile(defs: readonly LabelDef[]): CompiledLabel[] {
  let c = compiledCache.get(defs);
  if (!c) {
    c = defs.flatMap((d) =>
      d.labels.map((label) => {
        const key = toMatchKey(label).replace(/ /g, '');
        return { field: d.field, label, key, maxDist: maxLabelDistance(key.length) };
      }),
    );
    compiledCache.set(defs, c);
  }
  return c;
}

interface Candidate extends LabelHit {
  firstTok: number;
  lastTok: number;
}

/** Нэг мөрөөс шошгын цохилтууд (давхцахгүй; урт нь түрүүлнэ, дараа нь засварын зай бага). */
export function findLabelHits(line: DocLine, defs: readonly LabelDef[]): LabelHit[] {
  const labels = compile(defs);
  const tokens = [...line.text.matchAll(TOKEN_RE)].map((m) => ({ text: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  const keyCache = new Map<string, string>();
  const bestCache = new Map<string, { field: string; dist: number } | null>();
  const keyOf = (s: string): string => {
    let k = keyCache.get(s);
    if (k === undefined) {
      k = toMatchKey(s).replace(/ /g, '');
      keyCache.set(s, k);
    }
    return k;
  };

  const candidates: Candidate[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let n = 1; n <= EXTRACT_DEFAULTS.maxLabelTokens && i + n <= tokens.length; n++) {
      const window = tokens.slice(i, i + n);
      if (window.some((t) => t.text.length > MAX_LABEL_TOKEN_LENGTH)) break; // шошго урт үг агуулахгүй (хог/адверсари оролтыг алгасна)
      const key = keyOf(window.map((t) => t.text).join(' '));
      if (key === '') continue;
      let best = bestCache.get(key);
      if (best === undefined) {
        best = null;
        for (const l of labels) {
          if (Math.abs(l.key.length - key.length) > l.maxDist) continue;
          const dist = key === l.key ? 0 : levenshtein(key, l.key);
          if (dist <= l.maxDist && (best === null || dist < best.dist)) best = { field: l.field, dist };
        }
        bestCache.set(key, best);
      }
      if (best) {
        candidates.push({
          field: best.field,
          lineIdx: line.idx,
          start: line.start + window[0].start,
          end: line.start + window[n - 1].end,
          tokenCount: n,
          distance: best.dist,
          firstTok: i,
          lastTok: i + n - 1,
        });
      }
    }
  }
  candidates.sort((a, b) => b.tokenCount - a.tokenCount || a.distance - b.distance || a.firstTok - b.firstTok);
  const taken = new Set<number>();
  const chosen: Candidate[] = [];
  for (const c of candidates) {
    let free = true;
    for (let t = c.firstTok; t <= c.lastTok; t++) if (taken.has(t)) free = false;
    if (!free) continue;
    for (let t = c.firstTok; t <= c.lastTok; t++) taken.add(t);
    chosen.push(c);
  }
  return chosen.sort((a, b) => a.start - b.start).map(({ firstTok: _f, lastTok: _l, ...hit }) => hit);
}

export function findAllLabelHits(doc: OcrDoc, defs: readonly LabelDef[]): LabelHit[] {
  return doc.lines.flatMap((l) => findLabelHits(l, defs));
}

/**
 * Талбарын утгын нэр дэвшигчид (тэргүүлэх дараалалтай): (1) шошгоны дараах тухайн мөрийн хэсэг (дараагийн шошго хүртэл),
 * (2) дараагийн мөр — харин тэр мөр шошгоор эхэлж байвал утга биш. Тухайн мөрөнд ≥ 2 шошго байвал дараагийн мөрийг БАГАНААР
 * хуваана: шошго бүрийн x-ээс эхлээд дараагийн шошгын x хүртэлх үгс (хайрцаг байгаа үед).
 */
export function valueCandidates(doc: OcrDoc, hits: readonly LabelHit[], field: string): ValueCandidate[] {
  const out: ValueCandidate[] = [];
  const mine = hits.filter((h) => h.field === field);
  for (const h of mine) {
    const line = doc.lines[h.lineIdx];
    const lineHits = hits.filter((x) => x.lineIdx === h.lineIdx).sort((a, b) => a.start - b.start);
    const next = lineHits.find((x) => x.start >= h.end);
    out.push({ hit: h, start: h.end, end: next ? next.start : line.end, source: 'same-line' });
  }
  for (const h of mine) {
    const line = doc.lines[h.lineIdx];
    const nextLine = doc.lines[h.lineIdx + 1];
    if (!nextLine) continue;
    const nextHits = hits.filter((x) => x.lineIdx === nextLine.idx);
    if (nextHits.some((x) => x.start - nextLine.start <= 1)) continue; // дараагийн мөр өөрөө шошгоор эхэлж байна
    const lineHits = hits.filter((x) => x.lineIdx === line.idx).sort((a, b) => a.start - b.start);
    if (lineHits.length >= 2 && line.hasBoxes && nextLine.hasBoxes) {
      const col = columnWords(line, nextLine, lineHits, h);
      if (col) out.push({ hit: h, start: col.start, end: col.end, source: 'next-line' });
      continue;
    }
    out.push({ hit: h, start: nextLine.start, end: nextLine.end, source: 'next-line' });
  }
  return out;
}

/** Шошгоны мөрийн x-байрлалаар дараагийн мөрийн тухайн баганын үгс (байхгүй бол null). */
function columnWords(line: DocLine, nextLine: DocLine, lineHits: readonly LabelHit[], hit: LabelHit): { start: number; end: number } | null {
  const xOf = (h: LabelHit): number => (line.words.find((w) => w.end > h.start) ?? line.words[0]).x;
  const height = Math.max(1, ...line.words.map((w) => w.height));
  const tol = height * 0.6;
  const i = lineHits.indexOf(hit);
  const lo = xOf(hit) - tol;
  const hi = i + 1 < lineHits.length ? xOf(lineHits[i + 1]) - tol : Number.POSITIVE_INFINITY;
  const sel = nextLine.words.filter((w) => w.x >= lo && w.x < hi);
  if (sel.length === 0) return null;
  return { start: sel[0].start, end: sel[sel.length - 1].end };
}
