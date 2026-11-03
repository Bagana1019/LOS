import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { DomainError } from '@los/nest-common';

// FR-11.1/11.2: docx загвар дахь `{{placeholder}}`-ийг өгөгдлөөр солино. Давталт `{{#schedule}}…{{/schedule}}` (хүснэгтийн мөр).
const DELIMITERS = { start: '{{', end: '}}' } as const;
export const TAG_RE = /\{\{\s*[#/^]?\s*([A-Za-z_][\w.]*)\s*\}\}/g;

function open(buffer: Buffer): { zip: PizZip; doc: Docxtemplater } {
  try {
    const zip = new PizZip(buffer);
    if (!zip.file('word/document.xml')) throw new Error('word/document.xml missing');
    // nullGetter: өгөгдөлгүй placeholder хоосон үлдэнэ (алдаа биш)
    const doc = new Docxtemplater(zip, { delimiters: { ...DELIMITERS }, paragraphLoop: true, linebreaks: true, nullGetter: () => '' });
    return { zip, doc };
  } catch (e) {
    const multi = (e as { properties?: { errors?: Array<{ properties?: { explanation?: string } }> } }).properties?.errors;
    const detail = multi?.map((x) => x.properties?.explanation).filter(Boolean).slice(0, 3).join('; ');
    throw new DomainError('TEMPLATE_INVALID', `Загварын docx буруу байна${detail ? `: ${detail}` : ''}`, 422);
  }
}

/** Загвар доторх placeholder түлхүүрүүд (давхардалгүй, дарааллаар). Алдаатай docx → 422 TEMPLATE_INVALID. */
export function extractPlaceholders(buffer: Buffer): string[] {
  const text = open(buffer).doc.getFullText();
  const keys: string[] = [];
  for (const m of text.matchAll(TAG_RE)) if (!keys.includes(m[1]!)) keys.push(m[1]!);
  return keys;
}

export function fillDocx(buffer: Buffer, data: Record<string, unknown>): Buffer {
  const { zip, doc } = open(buffer);
  try {
    doc.render(data);
  } catch (e) {
    throw new DomainError('TEMPLATE_RENDER_FAILED', 'Загварыг өгөгдлөөр дүүргэж чадсангүй', 422, { reason: (e as Error).message.slice(0, 200) });
  }
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;
}
