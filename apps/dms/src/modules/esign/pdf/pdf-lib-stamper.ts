// FR-11.4 PdfStamper-ийн pdf-lib гүйцэтгэл: хуудас бүрт QR + тайлбар (+ mock ус тэмдэг), төгсгөлд гарын үсгийн хуудас,
// metadata, `signature.p7s` хавсралт. Гаралт deterministic (огноо = signedAt, санамсаргүй нэр/id-гүй): ижил оролт → ижил bytes.
// Хязгаарлалт: PDF /UserUnit (≠1) дэмжигдэхгүй; шифрлэгдсэн/эвдэрсэн PDF → InvalidPdfError.
import { Injectable } from '@nestjs/common';
import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFDocument, PDFName, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import * as QRCode from 'qrcode';
import { InvalidPdfError, type PdfStamper, type StampInput } from '../ports/pdf-stamper.port';
import { loadFontBytes } from './fonts';
import { groupVerificationCode } from './format';
import { createPageFrame, readPageGeometry, type PageGeometry } from './page-frame';
import { CAPTION_LABEL, drawPageStamp, drawWatermark, planPageStamp, planWatermark, type StampFonts } from './page-stamp';
import { buildSignatureContent, drawSignaturePage, layoutSignaturePage, signaturePageSize } from './signature-page';
import { sanitizeText } from './text-layout';

const PRODUCER = 'LOS Radix DMS';
const SIGNATURE_ATTACHMENT_NAME = 'signature.p7s';
/** PDF-ийн header ("%PDF-") эхний 1024 байт дотор байх ёстой (Acrobat-ийн хүлцэл) */
const HEADER_SCAN_BYTES = 1024;
/** Subset шрифтийн нэрийн угтвар (PDF spec: 6 том үсэг + `+`) — санамсаргүй биш тул гаралт тогтвортой */
const FONT_SUBSET_TAG = 'LOSDMS';
/** QR: 1 модуль = 8 px, эргэн тойрондоо 2 модулийн цагаан хүрээ (хуудасны цагаан захтай нийлж quiet zone-ийг хангана) */
const QR_OPTIONS: QRCode.QRCodeToBufferOptions = { type: 'png', errorCorrectionLevel: 'M', margin: 2, scale: 8 };

@Injectable()
export class PdfLibStamper implements PdfStamper {
  async stamp(input: StampInput): Promise<Buffer> {
    assertStampInput(input);
    assertPdfHeader(input.pdf);

    const { doc, pages, geometries } = await readSource(input.pdf);

    doc.registerFontkit(fontkit);
    const [regularBytes, boldBytes, qrPng] = await Promise.all([
      loadFontBytes('regular'),
      loadFontBytes('bold'),
      QRCode.toBuffer(input.verifyUrl, QR_OPTIONS),
    ]);
    const fonts = {
      regular: await embedSubsetFont(doc, regularBytes, 'DejaVuSans'),
      bold: await embedSubsetFont(doc, boldBytes, 'DejaVuSans-Bold'),
    };
    const qrImage = await doc.embedPng(qrPng);
    const resources = { ...fonts, qrImage };

    const code = groupVerificationCode(sanitizeText(input.verificationCode));
    // Хэсэг бүрийг тусад нь цэвэрлэнэ: хэт урт гэрээний дугаар төгсгөл дэх кодыг таслахгүй (sanitizeText төгсгөлөөс нь тасалдаг)
    const caption = `${CAPTION_LABEL} · ${sanitizeText(input.contractNo)} · ${code}`;
    pages.forEach((page, i) => {
      const frame = createPageFrame(geometries[i].visible, geometries[i].rotation);
      const plan = planPageStamp(frame.width, frame.height, caption, fonts, input.mock);
      drawPageStamp(page, frame, plan, resources);
    });

    appendSignaturePage(doc, input, geometries[0], resources);

    await applyMetadata(doc, input, code);
    // updateFieldAppearances=false: эх баримтын form талбарын харагдах байдлыг pdf-lib Helvetica-аар дахин зурахгүй (кирилл утгатай бол алдаа шидэх байсан)
    const bytes = await doc.save({ updateFieldAppearances: false });
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

function assertStampInput(input: StampInput): void {
  const bad = (field: string): never => {
    throw new TypeError(`invalid stamp input: ${field}`);
  };
  if (!Buffer.isBuffer(input.pdf)) bad('pdf');
  if (!Buffer.isBuffer(input.signatureCms) || input.signatureCms.length === 0) bad('signatureCms');
  for (const [field, value] of [
    ['contractNo', input.contractNo],
    ['signerName', input.signerName],
    ['signerRegisterMasked', input.signerRegisterMasked],
    ['providerDisplayName', input.providerDisplayName],
    ['originalSha256', input.originalSha256],
    ['verificationCode', input.verificationCode],
  ] as const) {
    if (typeof value !== 'string' || sanitizeText(value).length === 0) bad(field);
  }
  for (const [field, value] of [
    ['signedAt', input.signedAt],
    ['certificate.notBefore', input.certificate.notBefore],
    ['certificate.notAfter', input.certificate.notAfter],
  ] as const) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) bad(field);
  }
  // QR зөвхөн вэб холбоос агуулна — өөр схем (javascript:, tel: …) зэргийг оруулахгүй
  let protocol = '';
  try {
    protocol = new URL(input.verifyUrl).protocol;
  } catch {
    bad('verifyUrl');
  }
  if (protocol !== 'https:' && protocol !== 'http:') bad('verifyUrl');
}

function assertPdfHeader(pdf: Buffer): void {
  if (!pdf.subarray(0, HEADER_SCAN_BYTES).includes('%PDF-')) throw new InvalidPdfError('source is not a PDF (missing %PDF- header)');
}

interface SourceDocument {
  doc: PDFDocument;
  pages: PDFPage[];
  geometries: PageGeometry[];
}

// pdf-lib ES5 target-ээр build хийгдсэн тул `error instanceof EncryptedPDFError` ажиллахгүй (Error-ийн prototype chain тасардаг) — мессежээр таниж, тестээр баталгаажуулна
const isEncryptedError = (error: unknown): boolean => error instanceof Error && /\bis encrypted\b/.test(error.message);

/** Эх PDF-ийг уншиж, бүх хуудасны бүтэц/хэмжээг шалгана. Эндээс гарсан алдаа бүр эх файлын буруу тул InvalidPdfError болно. */
async function readSource(pdf: Buffer): Promise<SourceDocument> {
  let doc: PDFDocument;
  try {
    // updateMetadata=false: pdf-lib ачаалахдаа Info-д "одоогийн цаг" болон `Creator: pdf-lib`-ийг бичдэг — эх баримтад брэнд нэмэхгүй, deterministic байлгахын тулд унтраана
    doc = await PDFDocument.load(pdf, { updateMetadata: false });
  } catch (error) {
    throw new InvalidPdfError(isEncryptedError(error) ? 'source PDF is encrypted' : 'source PDF is corrupt or unsupported');
  }
  try {
    const pages = doc.getPages();
    const geometries = pages.map((page) => {
      assertDrawable(page);
      return readPageGeometry(page);
    });
    if (pages.length === 0) throw new InvalidPdfError('source PDF has no pages');
    return { doc, pages, geometries };
  } catch (error) {
    if (error instanceof InvalidPdfError) throw error;
    throw new InvalidPdfError('source PDF has an unreadable page tree or page geometry');
  }
}

/** Зурахдаа хүрэх /Contents, /Resources (Font, XObject, ExtGState), /Annots-ийн төрлийг урьдчилан шалгана — эвдэрсэн хуудас зурах үед биш эндээс таслагдана. */
function assertDrawable(page: PDFPage): void {
  const { Contents } = page.node.normalizedEntries();
  // normalize() дараа /Contents нь хоосон эсвэл массив байх ёстой (дан stream-ийг массив болгосон)
  if (Contents !== undefined && !(Contents instanceof PDFArray)) throw new Error('page /Contents is not a stream or an array of streams');
}

/** Төгсгөлд гарын үсгийн хуудас нэмнэ: эхний хуудасны харагдах хэмжээтэй (доод хязгаартай), эргэлтгүй. */
function appendSignaturePage(doc: PDFDocument, input: StampInput, firstPage: PageGeometry, resources: StampFonts & { qrImage: PDFImage }): void {
  const first = createPageFrame(firstPage.visible, firstPage.rotation);
  const { width, height } = signaturePageSize(first.width, first.height);
  const page = doc.addPage([width, height]);
  if (input.mock) {
    drawWatermark(page, createPageFrame({ x: 0, y: 0, width, height }, 0), planWatermark(width, height, resources.bold), resources.bold);
  }
  drawSignaturePage(page, layoutSignaturePage(buildSignatureContent(input), resources, width, height), resources);
}

function embedSubsetFont(doc: PDFDocument, bytes: Uint8Array, name: string): Promise<PDFFont> {
  return doc.embedFont(bytes, { subset: true, customName: `${FONT_SUBSET_TAG}+${name}` });
}

async function applyMetadata(doc: PDFDocument, input: StampInput, groupedCode: string): Promise<void> {
  doc.setTitle(`${sanitizeText(input.contractNo)} — гарын үсэгтэй`);
  doc.setProducer(PRODUCER);
  doc.setKeywords([`verification:${groupedCode}`, `sha256:${sanitizeText(input.originalSha256, 128)}`, `provider:${input.provider}`]);
  doc.setCreationDate(input.signedAt);
  doc.setModificationDate(input.signedAt);
  // Эх баримтын XMP нь хуучин гарчиг/огноо/producer-ийг агуулсан хэвээр үлдэж Info-той зөрөхөөс сэргийлнэ
  doc.catalog.delete(PDFName.of('Metadata'));
  await doc.attach(input.signatureCms, SIGNATURE_ATTACHMENT_NAME, {
    mimeType: 'application/pkcs7-signature',
    description: `CMS (PKCS#7) detached гарын үсэг — эх баримтын SHA-256: ${sanitizeText(input.originalSha256, 128)}`,
    creationDate: input.signedAt,
    modificationDate: input.signedAt,
  });
}
