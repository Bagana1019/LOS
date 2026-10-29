// Тестийн PDF үүсгэгч (pdf-lib). ЗОХИОМОЛ өгөгдөл: бодит банк, хүн, данс алга. Зөвхөн стандарт Latin фонт (Helvetica, Courier).
import { degrees, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, type PDFFont } from 'pdf-lib';

export type PdfFontName = 'Helvetica' | 'Helvetica-Bold' | 'Courier';

export interface DrawText {
  text: string;
  x: number;
  y: number;
  size?: number;
  font?: PdfFontName;
  /** Зүүн тийш эргүүлсэн градус (pdf-lib `rotate`) */
  rotate?: number;
  /** x нь текстийн ЗҮҮН биш БАРУУН ирмэг (тоон багана) */
  alignRight?: boolean;
}

export interface PdfPageSpec {
  texts: DrawText[];
  width?: number;
  height?: number;
  /** Хуудасны /Rotate (0, 90, 180, 270) */
  rotation?: number;
}

export interface PdfSpec {
  pages: PdfPageSpec[];
  producer?: string;
  creator?: string;
  title?: string;
  author?: string;
  creationDate?: Date;
  modDate?: Date;
  /** 'signed': SigFlags + /V; 'unsigned': зөвхөн хоосон гарын үсгийн талбар */
  signature?: 'signed' | 'unsigned';
}

const FONTS: Record<PdfFontName, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  'Helvetica-Bold': StandardFonts.HelveticaBold,
  Courier: StandardFonts.Courier,
};

export async function buildPdf(spec: PdfSpec): Promise<Buffer> {
  // updateMetadata:false — pdf-lib өөрөө producer/огноо тавихгүй (тест тодорхой)
  const doc = await PDFDocument.create({ updateMetadata: false });
  if (spec.producer !== undefined) doc.setProducer(spec.producer);
  if (spec.creator !== undefined) doc.setCreator(spec.creator);
  if (spec.title !== undefined) doc.setTitle(spec.title);
  if (spec.author !== undefined) doc.setAuthor(spec.author);
  if (spec.creationDate) doc.setCreationDate(spec.creationDate);
  if (spec.modDate) doc.setModificationDate(spec.modDate);

  const fonts = new Map<PdfFontName, PDFFont>();
  for (const name of Object.keys(FONTS) as PdfFontName[]) fonts.set(name, await doc.embedFont(FONTS[name]));

  let firstPage: ReturnType<PDFDocument['addPage']> | null = null;
  for (const p of spec.pages) {
    const page = doc.addPage([p.width ?? 595, p.height ?? 842]);
    firstPage ??= page;
    if (p.rotation) page.setRotation(degrees(p.rotation));
    for (const t of p.texts) {
      const font = fonts.get(t.font ?? 'Helvetica') as PDFFont;
      const size = t.size ?? 9;
      const x = t.alignRight ? t.x - font.widthOfTextAtSize(t.text, size) : t.x;
      page.drawText(t.text, { x, y: t.y, size, font, ...(t.rotate ? { rotate: degrees(t.rotate) } : {}) });
    }
  }

  if (spec.signature && firstPage) {
    const ctx = doc.context;
    const entries: Record<string, unknown> = {
      Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'), Rect: [10, 10, 100, 40], F: 4, P: firstPage.ref,
    };
    if (spec.signature === 'signed') {
      entries.V = ctx.register(
        ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', ByteRange: [0, 0, 0, 0], Contents: PDFHexString.of('00') }),
      );
    }
    const widget = ctx.register(ctx.obj(entries as Parameters<typeof ctx.obj>[0]));
    firstPage.node.set(PDFName.of('Annots'), ctx.obj([widget]));
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [widget], SigFlags: spec.signature === 'signed' ? 3 : 0 }));
  }
  return Buffer.from(await doc.save());
}

// ---- Хуулга шиг хүснэгт: толгой + 20 мөр + шилжсэн (wrap) тайлбар + 2-р хуудас ----

export const SYNTHETIC_COLUMNS = { dateX: 40, descX: 115, debitRight: 380, creditRight: 450, balanceRight: 535 } as const;
const ROW_STEP = 14;
const WRAP_STEP = 10;

export interface SyntheticRow {
  date: string;
  description: string;
  /** Тайлбарын 2-р мөр (wrap); байвал тусдаа line болно */
  descriptionWrap?: string;
  debit: string;
  credit: string;
  balance: string;
}

export const SYNTHETIC_HEADER = ['Date', 'Description', 'Debit', 'Credit', 'Balance'] as const;

/** 20 мөр; 5-р мөр wrap-тай. Тоонууд мянгатын таслалтай (бүтэн нүд хэвээр гарах ёстой). */
export function syntheticRows(): SyntheticRow[] {
  const rows: SyntheticRow[] = [];
  let balance = 2_000_000;
  for (let i = 1; i <= 20; i++) {
    const credit = i % 3 === 0 ? i * 125_000 : 0;
    const debit = credit === 0 ? i * 7_500 + 250 : 0;
    balance += credit - debit;
    rows.push({
      date: `2026-03-${String(i).padStart(2, '0')}`,
      description: i === 5 ? 'Payment for services rendered under agreement' : `Transfer ref ${1000 + i}`,
      descriptionWrap: i === 5 ? 'no. 17 (synthetic continuation line)' : undefined,
      debit: debit ? fmt(debit) : '',
      credit: credit ? fmt(credit) : '',
      balance: fmt(balance),
    });
  }
  return rows;
}

function fmt(n: number): string {
  return `${n.toLocaleString('en-US')}.00`;
}

export interface SyntheticStatement {
  spec: PdfSpec;
  /** Хуудас тутмын line тутмын хүлээгдэх нүднүүд (хоосон нүд PDF-д алга) */
  expected: string[][][];
  rows: SyntheticRow[];
}

export function syntheticStatement(extra: Partial<PdfSpec> = {}): SyntheticStatement {
  const rows = syntheticRows();
  const c = SYNTHETIC_COLUMNS;
  const pages: PdfPageSpec[] = [];
  const expected: string[][][] = [];
  const split = 12; // 1-р хуудсанд эхний 12 мөр
  for (const [pageIdx, chunk] of [rows.slice(0, split), rows.slice(split)].entries()) {
    const texts: DrawText[] = [];
    const lines: string[][] = [];
    let y = 800;
    if (pageIdx === 0) {
      texts.push({ text: 'ACCOUNT STATEMENT (SYNTHETIC SAMPLE)', x: c.dateX, y, size: 12, font: 'Helvetica-Bold' });
      lines.push(['ACCOUNT STATEMENT (SYNTHETIC SAMPLE)']);
      y -= 24;
    }
    const header = SYNTHETIC_HEADER;
    texts.push(
      { text: header[0], x: c.dateX, y, font: 'Helvetica-Bold' },
      { text: header[1], x: c.descX, y, font: 'Helvetica-Bold' },
      { text: header[2], x: c.debitRight, y, font: 'Helvetica-Bold', alignRight: true },
      { text: header[3], x: c.creditRight, y, font: 'Helvetica-Bold', alignRight: true },
      { text: header[4], x: c.balanceRight, y, font: 'Helvetica-Bold', alignRight: true },
    );
    lines.push([...header]);
    for (const r of chunk) {
      y -= ROW_STEP;
      texts.push({ text: r.date, x: c.dateX, y }, { text: r.description, x: c.descX, y });
      if (r.debit) texts.push({ text: r.debit, x: c.debitRight, y, alignRight: true });
      if (r.credit) texts.push({ text: r.credit, x: c.creditRight, y, alignRight: true });
      texts.push({ text: r.balance, x: c.balanceRight, y, alignRight: true });
      lines.push([r.date, r.description, ...[r.debit, r.credit, r.balance].filter((v) => v !== '')]);
      if (r.descriptionWrap) {
        y -= WRAP_STEP;
        texts.push({ text: r.descriptionWrap, x: c.descX, y });
        lines.push([r.descriptionWrap]);
      }
    }
    if (pageIdx === 1) {
      texts.push({ text: `Page 2 of 2 - end of synthetic statement`, x: c.dateX, y: 60, size: 8 });
      lines.push(['Page 2 of 2 - end of synthetic statement']);
    }
    pages.push({ texts });
    expected.push(lines);
  }
  return { spec: { pages, producer: 'Synthetic Test Producer', creator: 'Synthetic Test Creator', ...extra }, expected, rows };
}
