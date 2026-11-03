import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont } from 'pdf-lib';
import { DomainError } from '@los/nest-common';
import { loadFontBytes } from '../esign/pdf/fonts';
import { sanitizeText, wrapText } from '../esign/pdf/text-layout';
import { docxBlocks } from './docx-blocks';

/** docx → PDF. `DOCX_PDF_ENGINE=libreoffice` үед LibreOffice (үйлдвэрлэл), анхдагч нь JS-ээр хялбар байрлуулалт (DEMO — зураг, хүснэгтийн гоо сайхан алга). */
export interface PdfConverter { convert(docx: Buffer): Promise<Buffer> }
export const PDF_CONVERTER = Symbol('PDF_CONVERTER');

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;
const SIZE = 10.5;
const LEADING = 15;

/** DEMO: тэмдэг, догол мөр, хүснэгт (тэнцүү багана, нүдний хүрээтэй). Кирилл — DejaVu Sans. */
export class PdfLibConverter implements PdfConverter {
  async convert(docx: Buffer): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const regular = await pdf.embedFont(await loadFontBytes('regular'), { subset: true });
    const bold = await pdf.embedFont(await loadFontBytes('bold'), { subset: true });
    const width = A4[0] - 2 * MARGIN;
    let page = pdf.addPage(A4);
    let y = A4[1] - MARGIN;
    const room = (need: number) => { if (y - need < MARGIN) { page = pdf.addPage(A4); y = A4[1] - MARGIN; } };
    const lines = (text: string, font: PDFFont, w: number): string[] =>
      text.split(/\n/).flatMap((para) => wrapText(sanitizeText(para.replace(/\t/g, '    '), 2000), font, SIZE, w));

    for (const b of docxBlocks(docx)) {
      if (b.kind === 'p') {
        const font = b.bold ? bold : regular;
        const ls = lines(b.text, font, width);
        for (const l of ls) { room(LEADING); y -= LEADING; if (l) page.drawText(l, { x: MARGIN, y: y + 4, size: SIZE, font }); }
        if (!b.text.trim()) { room(LEADING / 2); y -= LEADING / 2; }
      } else {
        const cols = Math.max(...b.rows.map((r) => r.length), 1);
        const cw = width / cols;
        b.rows.forEach((row, ri) => {
          const font = ri === 0 ? bold : regular;
          const cells = Array.from({ length: cols }, (_, i) => lines(row[i] ?? '', font, cw - 8));
          const h = Math.max(...cells.map((c) => c.length)) * LEADING + 4;
          room(h);
          cells.forEach((cl, ci) => {
            const x = MARGIN + ci * cw;
            page.drawRectangle({ x, y: y - h, width: cw, height: h, borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 0.5 });
            cl.forEach((l, li) => { if (l) page.drawText(l, { x: x + 4, y: y - (li + 1) * LEADING + 3, size: SIZE, font }); });
          });
          y -= h;
        });
        y -= LEADING / 2;
      }
    }
    return Buffer.from(await pdf.save());
  }
}

const exec = promisify(execFile);
export class LibreOfficeConverter implements PdfConverter {
  constructor(private readonly bin = process.env.SOFFICE_BIN ?? 'soffice', private readonly timeoutMs = 60_000) {}
  async convert(docx: Buffer): Promise<Buffer> {
    const dir = await mkdtemp(join(tmpdir(), 'los-docx-'));
    try {
      await writeFile(join(dir, 'in.docx'), docx);
      await exec(this.bin, ['--headless', '--norestore', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'pdf', '--outdir', dir, join(dir, 'in.docx')], { timeout: this.timeoutMs });
      return await readFile(join(dir, 'in.pdf'));
    } catch {
      throw new DomainError('PDF_CONVERSION_FAILED', 'Гэрээг PDF болгож чадсангүй', 502);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export const createPdfConverter = (env: NodeJS.ProcessEnv = process.env): PdfConverter => (env.DOCX_PDF_ENGINE === 'libreoffice' ? new LibreOfficeConverter() : new PdfLibConverter());
