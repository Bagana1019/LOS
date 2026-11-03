import PizZip from 'pizzip';

// docx → PDF хөрвүүлэгчид зориулсан хялбар задлалт: догол мөр ба хүснэгт.
export type DocBlock = { kind: 'p'; text: string; bold: boolean } | { kind: 'table'; rows: string[][] };

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decode = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m] ?? m).replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));

function paragraphText(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) out += m[1] !== undefined ? decode(m[1]) : m[0].startsWith('<w:tab') ? '\t' : '\n';
  return out;
}
const isBold = (xml: string): boolean => /<w:b(?:\s+w:val="(?:1|true)")?\s*\/>/.test(xml);

export function docxBlocks(docx: Buffer): DocBlock[] {
  const body = new PizZip(docx).file('word/document.xml')?.asText() ?? '';
  const blocks: DocBlock[] = [];
  // Дээд түвшний <w:tbl>…</w:tbl> ба <w:p>…</w:p>-ийг баримтын дарааллаар
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g;
  for (const m of body.matchAll(re)) {
    const xml = m[0];
    if (xml.startsWith('<w:tbl>')) {
      const rows = [...xml.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((tr) => [...tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((tc) => paragraphText(tc[0]).replace(/\s+/g, ' ').trim()));
      if (rows.length) blocks.push({ kind: 'table', rows: rows.filter((r) => r.length) });
    } else blocks.push({ kind: 'p', text: paragraphText(xml), bold: isBold(xml) });
  }
  return blocks;
}
