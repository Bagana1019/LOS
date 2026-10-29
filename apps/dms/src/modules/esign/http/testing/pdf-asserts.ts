// FR-11.4 e2e-д гарын үсэгтэй PDF-ийг шалгах туслахууд (production-д ашиглагдахгүй). Текст: `pdftotext` (байвал) + ToUnicode-аар задлах (pdf-inspect).
import { spawnSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { expectedQrMatrix, extractImages, pageText, readAttachments, readQrMatrix } from '../../pdf/pdf-inspect';

export interface PdfFacts {
  pageCount: number;
  /** Хуудас бүрийн текстийн хэсгүүд (ToUnicode) */
  pageTexts: string[][];
  /** Хуудас бүр дэх QR-ийн агуулга `url`-тэй таарах эсэх */
  qrMatchesOnEveryPage(url: string): boolean;
  attachments: Array<{ name: string; bytes: Buffer }>;
  title: string | undefined;
  keywords: string | undefined;
}

export async function inspectPdf(bytes: Buffer): Promise<PdfFacts> {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  return {
    pageCount: pages.length,
    pageTexts: pages.map((page) => pageText(doc, page)),
    qrMatchesOnEveryPage: (url) => {
      const expected = JSON.stringify(expectedQrMatrix(url));
      return pages.every((page) => extractImages(doc, page).some((image) => JSON.stringify(readQrMatrix(image)) === expected));
    },
    attachments: readAttachments(doc).map(({ name, bytes: content }) => ({ name, bytes: content })),
    title: doc.getTitle(),
    keywords: doc.getKeywords(),
  };
}

/** poppler-ийн `pdftotext`. Суулгаагүй бол `null` (тест pdf-inspect-ийн шалгалтаар хязгаарлагдана) */
export function pdftotext(bytes: Buffer): string | null {
  const result = spawnSync('pdftotext', ['-enc', 'UTF-8', '-', '-'], { input: bytes, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.error || result.status !== 0 ? null : result.stdout;
}
