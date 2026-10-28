import { TEMPLATE_PLACEHOLDERS } from '@los/contracts';

// FR-13.2: мэдэгдлийн загварын {{placeholder}} render. Цэвэр функцүүд (I/O байхгүй).

export type TemplateValue = string | number | null | undefined;
export type TemplateVars = Partial<Record<string, TemplateValue>>;

const ALLOWED = new Set<string>(TEMPLATE_PLACEHOLDERS);
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Загварт орсон placeholder-ийн нэрс (давхардалгүй, гарсан дарааллаар). */
export function extractPlaceholders(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) if (!names.includes(m[1])) names.push(m[1]);
  return names;
}

/** Зөвшөөрөгдөөгүй placeholder-ийн нэрс + буруу хаалт (`{{ … ` хаагдаагүй, `{{a b}}`) байвал `{{…}}` гэж тэмдэглэнэ. */
export function findInvalidPlaceholders(...texts: Array<string | null | undefined>): string[] {
  const bad: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const name of extractPlaceholders(text)) if (!ALLOWED.has(name) && !bad.includes(name)) bad.push(name);
    const stripped = text.replace(PLACEHOLDER, '');
    if (/\{\{|\}\}/.test(stripped) && !bad.includes('{{…}}')) bad.push('{{…}}');
  }
  return bad;
}

/** 1234567.5 → "1,234,567.50"; бүхэл бол орон нэмэхгүй: 1200000 → "1,200,000". */
export function formatAmount(n: number): string {
  if (!Number.isFinite(n)) return '';
  const rounded = Math.round(n * 100) / 100;
  const [int, frac] = Math.abs(rounded).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${rounded < 0 ? '-' : ''}${grouped}${frac === '00' ? '' : `.${frac}`}`;
}

function valueOf(name: string, vars: TemplateVars): string {
  const v = vars[name];
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return name === 'amount' ? formatAmount(v) : String(v);
  return String(v);
}

/** Үл мэдэгдэх placeholder болон утгагүй placeholder → хоосон. Нэг дамжилт тул утга доторх `{{x}}` дахин задрахгүй. */
export function renderText(source: string, vars: TemplateVars): string {
  return source.replace(PLACEHOLDER, (_m, name: string) => (ALLOWED.has(name) ? valueOf(name, vars) : '')).trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Render хийсэн текстээс имэйлийн html: бүх зүйлийг escape хийж, хоосон мөрөөр догол мөр, мөр бүрийг <br>. */
export function textToHtml(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2933">${paragraphs.join('')}</div>`;
}

/** SMS-ийн сегментийн тоо: кирилл (GSM-7-д байхгүй) → UCS-2, 70 / залгагдсан бол 67 тэмдэгт. */
export function smsSegments(text: string): { encoding: 'GSM7' | 'UCS2'; length: number; segments: number } {
  const length = [...text].length;
  const gsm = /^[\nA-Za-z0-9 @£$¥!"#¤%&'()*+,\-./:;<=>?¡§¿_]*$/.test(text);
  if (length === 0) return { encoding: gsm ? 'GSM7' : 'UCS2', length, segments: 0 };
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return { encoding: gsm ? 'GSM7' : 'UCS2', length, segments: length <= single ? 1 : Math.ceil(length / multi) };
}
