// FR-11.4 Штамп дээр зурах текстийг цэвэрлэх, мөр таслах, багтаах — шрифтийн жинхэнэ хэмжүүрээр (PDFFont.widthOfTextAtSize).
// Урт нэр/хэш/URL хуудсаас хэзээ ч халихгүй: үг хэтэрвэл зөөлөн таслах цэг (`/ - _ . …`)-ээр, түүнгүй бол тэмдэгтээр таслана.

export interface TextMeasure {
  widthOfTextAtSize(text: string, size: number): number;
}

/** Нэг талбарын дээд урт (код цэгээр). Provider/гэрчилгээнээс ирсэн хэт урт утга PDF-г томруулж, CPU идэхээс сэргийлнэ. */
export const MAX_FIELD_CHARS = 256;
const ELLIPSIS = '…';
const SOFT_BREAK_AFTER = new Set(['/', '-', '_', '.', ',', ';', ':', '?', '&', '=', '#', '%']);

/** Харагдах байдлыг хуурдаг (чиглэл өөрчлөх, тэг өргөнтэй) тэмдэгтүүд — нэр/CN-д орсон ч штамп дээр зурахгүй. */
function isInvisibleFormat(cp: number): boolean {
  return (
    cp === 0xad ||
    cp === 0x61c ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x2066 && cp <= 0x206f) ||
    cp === 0xfeff
  );
}

const isBlank = (cp: number, ch: string): boolean => cp <= 0x20 || (cp >= 0x7f && cp <= 0x9f) || /\s/u.test(ch);

/**
 * Нэг мөрийн текст болгоно: control/мөр таслах тэмдэгтийг зай болгож давхцлыг нэгтгэнэ, bidi/zero-width тэмдэгтийг хасна,
 * дан surrogate-ийг U+FFFD болгоно, `maxChars`-аас урт бол `…`-ээр таслана.
 */
export function sanitizeText(text: string, maxChars = MAX_FIELD_CHARS): string {
  const chars: string[] = [];
  let pendingSpace = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInvisibleFormat(cp)) continue;
    if (isBlank(cp, ch)) {
      pendingSpace = chars.length > 0;
      continue;
    }
    if (pendingSpace) chars.push(' ');
    pendingSpace = false;
    chars.push(cp >= 0xd800 && cp <= 0xdfff ? '�' : ch);
  }
  if (chars.length <= maxChars) return chars.join('');
  return chars.slice(0, Math.max(0, maxChars - 1)).join('').trimEnd() + ELLIPSIS;
}

function splitAtSoftBreaks(word: string): string[] {
  const segments: string[] = [];
  let segment = '';
  for (const ch of word) {
    segment += ch;
    if (SOFT_BREAK_AFTER.has(ch)) {
      segments.push(segment);
      segment = '';
    }
  }
  if (segment) segments.push(segment);
  return segments;
}

/** `chars[start…]`-аас эхлээд `maxWidth`-д багтах хамгийн урт угтварын урт (≥ 1 — явцуу баганад ч урагшилна). Хоёртын хайлт: O(n log n). */
function longestFit(chars: string[], start: number, width: (text: string) => number, maxWidth: number): number {
  let lo = 1;
  let hi = chars.length - start;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (width(chars.slice(start, start + mid).join('')) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function breakLongWord(word: string, width: (text: string) => number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const segment of splitAtSoftBreaks(word)) {
    if (width(line + segment) <= maxWidth) {
      line += segment;
      continue;
    }
    if (line) {
      lines.push(line);
      line = '';
    }
    if (width(segment) <= maxWidth) {
      line = segment;
      continue;
    }
    const chars = Array.from(segment);
    for (let start = 0; start < chars.length; ) {
      const fit = longestFit(chars, start, width, maxWidth);
      const piece = chars.slice(start, start + fit).join('');
      start += fit;
      // Сүүлчийн хэсгийг дараагийн сегменттэй залгахын тулд мөр болгон түлхэхгүй
      if (start < chars.length) lines.push(piece);
      else line = piece;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Нэг догол мөрийг (`\n`-гүй, sanitizeText-ээр цэвэрлэсэн) `maxWidth`-д багтаан мөрүүдэд хуваана. Хоосон текст → `['']`. */
export function wrapText(text: string, font: TextMeasure, size: number, maxWidth: number): string[] {
  const width = (value: string): number => font.widthOfTextAtSize(value, size);
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (!word) continue;
    const candidate = current ? `${current} ${word}` : word;
    if (width(candidate) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = '';
    }
    if (width(word) <= maxWidth) {
      current = word;
      continue;
    }
    const pieces = breakLongWord(word, width, maxWidth);
    lines.push(...pieces.slice(0, -1));
    current = pieces[pieces.length - 1] ?? '';
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

/** `line`-ийг төгсгөлөөс нь хасаж `…`-тэй нь `maxWidth`-д багтаана. */
export function ellipsize(line: string, font: TextMeasure, size: number, maxWidth: number): string {
  const chars = Array.from(line);
  while (chars.length > 0 && font.widthOfTextAtSize(chars.join('').trimEnd() + ELLIPSIS, size) > maxWidth) chars.pop();
  return chars.join('').trimEnd() + ELLIPSIS;
}

export interface FitOptions {
  maxSize: number;
  minSize: number;
  maxWidth: number;
  /** Хамгийн бага хэмжээнд ч багтахгүй бол мөрөнд хуваах дээд тоо; давбал сүүлийн мөрийг `…`-ээр таслана */
  maxLines: number;
}
export interface FittedText {
  size: number;
  lines: string[];
}

const FIT_STEP_PT = 0.25;

/** Нэг мөрөнд хамгийн том боломжит хэмжээгээр багтаана; `minSize`-д ч багтахгүй бол мөрөнд хувааж `maxLines`-аар хязгаарлана. */
export function fitText(text: string, font: TextMeasure, options: FitOptions): FittedText {
  const { minSize, maxWidth, maxLines } = options;
  const maxSize = Math.max(options.maxSize, minSize);
  const steps = Math.floor((maxSize - minSize) / FIT_STEP_PT);
  for (let i = 0; i <= steps; i++) {
    const size = maxSize - i * FIT_STEP_PT;
    if (font.widthOfTextAtSize(text, size) <= maxWidth) return { size, lines: [text] };
  }
  return { size: minSize, lines: capLines(wrapText(text, font, minSize, maxWidth), maxLines, font, minSize, maxWidth) };
}

/** `lines`-ийг `maxLines`-д хязгаарлана; давбал сүүлийн мөрийг үлдсэн текстийн хамт `…`-ээр таслана. */
export function capLines(lines: string[], maxLines: number, font: TextMeasure, size: number, maxWidth: number): string[] {
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(`${kept[maxLines - 1]} ${lines[maxLines]}`, font, size, maxWidth);
  return kept;
}
