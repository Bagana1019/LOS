// FR-11.4 Төгсгөлд нэмэгдэх "ЦАХИМ ГАРЫН ҮСГИЙН ХУУДАС": том QR (~40 мм) + мэдээллийн хүснэгт + анхааруулга.
// layoutSignaturePage() нь цэвэр тооцоолол (хэмжээсийг жинхэнэ шрифтээр хэмжинэ, хуудсанд багтахгүй бол масштабыг багасгана),
// drawSignaturePage() нь үр дүнг pdf-lib руу зурна. Бүх хэмжээс PDF координатаар (эх нь зүүн доод булан).
import { grayscale, rgb, type Color, type PDFImage, type PDFPage } from 'pdf-lib';
import type { StampInput } from '../ports/pdf-stamper.port';
import { formatUlaanbaatar, groupVerificationCode, mm } from './format';
import type { StampFonts } from './page-stamp';
import { capLines, sanitizeText, wrapText, type TextMeasure } from './text-layout';

export const SIGNATURE_PAGE_TITLE = 'ЦАХИМ ГАРЫН ҮСГИЙН ХУУДАС';
/** Гарын үсгийн хуудасны хамгийн бага хэмжээ (A6 босоо орчим) — эхний хуудас үүнээс жижиг бол тал бүрийг нь энэ хэмжээгээр томруулна */
export const MIN_SIGNATURE_PAGE_WIDTH_PT = 300;
export const MIN_SIGNATURE_PAGE_HEIGHT_PT = 420;

const HINT_HEADING = 'Баримтын жинхэнэ эсэхийг шалгах';
const HINT_BODY =
  'Утасныхаа камераар QR кодыг уншуулах эсвэл доорх баталгаажуулах хаягаар орж, гарын үсгийн мэдээллийг тулгана уу.';
const DISCLAIMER =
  'Энэхүү хуудас нь дээр нэр бүхий этгээд баримтыг цахим гарын үсгээр баталгаажуулсныг гэрчилнэ. Гарын үсэг нь анхны (штампгүй) ' +
  'баримтын SHA-256 хэшийг баталгаажуулах бөгөөд CMS (PKCS#7) гарын үсгийг энэ PDF-ийн signature.p7s хавсралтаас авч болно. ' +
  'Баримтын жинхэнэ эсэхийг QR код эсвэл баталгаажуулах хаягаар шалгана уу.';
const MOCK_DISCLAIMER = 'АНХААРУУЛГА: ТЕСТ ГАРЫН ҮСЭГ. Энэ баримт хуурмаг (mock) гарын үсэгтэй тул ХҮЧИНГҮЙ.';

const MARGIN_PT = 48;
/** Өргөн хуудсанд (A4 хэвтээ, A3, A0) хүснэгтийн баганын дээд өргөн, pt — хуудасны төвд байрлана */
const MAX_COLUMN_PT = 520;
/** Хүснэгтийн нэг утга эхлээд энэ тооны мөр хүртэл, хуудсанд багтахгүй бол 1 мөр болтол `…`-ээр таслагдана (бүрэн утга нь CMS/QR-д үлдэнэ) */
const VALUE_LINE_CAPS = [4, 1] as const;
const QR_SIZE_PT = mm(40);
const QR_GAP_PT = 16;
/** QR-ийн хажууд тайлбар багтах хамгийн бага өргөн; үүнээс явцуу бол QR-ийг тайлбарын доор байрлуулна */
const MIN_HINT_WIDTH_PT = 150;
const LABEL_COLUMN_RATIO = 0.34;
const COLUMN_GAP_PT = 10;
const ROW_PAD_PT = 5;
const SCALE_STEP = 0.05;
const MIN_SCALE = 0.3;

const INK = grayscale(0.1);
const MUTED = grayscale(0.4);
const RULE_STRONG = grayscale(0.45);
const RULE_LIGHT = grayscale(0.82);
const ACCENT = rgb(0.1, 0.22, 0.45);
const ALERT = rgb(0.65, 0.1, 0.1);

export interface SignatureRow {
  label: string;
  /** Албадан мөр бүр тусдаа догол мөр (жишээ нь хэшийн 2 хагас); тус бүр өргөнд багтаан мөрлөгдөнө */
  lines: string[];
  /** Утгын үсгийн хэмжээ (pt, масштабаас өмнө) */
  size?: number;
  bold?: boolean;
}
export interface SignaturePageContent {
  rows: SignatureRow[];
  mock: boolean;
}

/** StampInput → хүснэгтийн мөрүүд. Бүх утга sanitizeText-ээр цэвэрлэгдэнэ (bidi/control тэмдэгт, хэт урт утга). */
export function buildSignatureContent(input: StampInput): SignaturePageContent {
  const t = (value: string): string => sanitizeText(value);
  const { certificate } = input;
  const sha = sanitizeText(input.originalSha256, 128);
  const half = Math.ceil(sha.length / 2);
  return {
    mock: input.mock,
    rows: [
      { label: 'Гэрээний дугаар', lines: [t(input.contractNo)] },
      { label: 'Гарын үсэг зурсан', lines: [t(input.signerName)] },
      { label: 'Регистр', lines: [t(input.signerRegisterMasked)] },
      { label: 'Үйлчилгээ үзүүлэгч', lines: [t(input.providerDisplayName)] },
      { label: 'Гэрчилгээ олгогч', lines: [t(certificate.issuer)] },
      { label: 'Гэрчилгээний сериал', lines: [t(certificate.serialNumber)] },
      {
        label: 'Гэрчилгээ хүчинтэй хугацаа',
        lines: [`${formatUlaanbaatar(certificate.notBefore)} – ${formatUlaanbaatar(certificate.notAfter)} (UTC+8)`],
      },
      {
        label: 'Гарын үсэг зурсан огноо',
        lines: [`${formatUlaanbaatar(input.signedAt)} (UTC+8)`, `${input.signedAt.toISOString()} (UTC)`],
      },
      { label: 'Баримтын SHA-256 (эх хувь)', lines: [sha.slice(0, half), sha.slice(half)], size: 8.5 },
      { label: 'Баталгаажуулах код', lines: [groupVerificationCode(t(input.verificationCode))], size: 12, bold: true },
      { label: 'Баталгаажуулах хаяг', lines: [t(input.verifyUrl)], size: 9 },
    ],
  };
}

export type LayoutOp =
  | { kind: 'text'; text: string; x: number; y: number; size: number; bold: boolean; color: Color; width: number }
  | { kind: 'rule'; x1: number; x2: number; y: number; thickness: number; color: Color }
  | { kind: 'qr'; x: number; y: number; size: number };

export interface SignaturePageLayout {
  width: number;
  height: number;
  /** 1 = A4-ийн нэрлэсэн хэмжээс; жижиг/намхан хуудсанд багасна */
  scale: number;
  /** Хүснэгт/текстийн хүрээ (зүүн, баруун x) — халилтын шалгалтад */
  column: { left: number; right: number };
  ops: LayoutOp[];
}

export interface MeasureFonts {
  regular: TextMeasure;
  bold: TextMeasure;
}

/** Хуудасны хэмжээг доод хязгаараар тэнцүүлнэ — маш жижиг эхний хуудсанд ч хүснэгт уншигдахуйц, багтахуйц байхын тулд. */
export function signaturePageSize(firstPageWidth: number, firstPageHeight: number): { width: number; height: number } {
  return {
    width: Math.max(firstPageWidth, MIN_SIGNATURE_PAGE_WIDTH_PT),
    height: Math.max(firstPageHeight, MIN_SIGNATURE_PAGE_HEIGHT_PT),
  };
}

/**
 * Хуудсанд багтах хамгийн том масштабаар (1 → 0.3, 5%-ийн алхамтай) байрлуулна. Хэт урт утгатай бол эхлээд утга бүрийг 4 мөрөөр,
 * тэр ч багтахгүй бол 1 мөрөөр (`…`-ээр) хязгаарлана тул хуудсаас хэзээ ч халихгүй.
 */
export function layoutSignaturePage(content: SignaturePageContent, fonts: MeasureFonts, width: number, height: number): SignaturePageLayout {
  for (const maxValueLines of VALUE_LINE_CAPS) {
    for (let scale = 1; scale >= MIN_SCALE - 1e-9; scale -= SCALE_STEP) {
      const layout = tryLayout(content, fonts, width, height, scale, maxValueLines);
      if (layout) return layout;
    }
  }
  // signaturePageSize() ба 1 мөрийн хязгаартай тул хүрэхгүй; хүрвэл халсан хуудас гаргахгүй, илт алдаа шиднэ
  throw new Error('signature page content does not fit the page');
}

function tryLayout(content: SignaturePageContent, fonts: MeasureFonts, W: number, H: number, s: number, maxValueLines: number): SignaturePageLayout | null {
  const ops: LayoutOp[] = [];
  const margin = MARGIN_PT * s;
  const columnWidth = Math.min(W - 2 * margin, MAX_COLUMN_PT);
  const left = (W - columnWidth) / 2;
  const right = left + columnWidth;
  const limit = H - margin;
  // Дээрээс доош хөдөлдөг курсор (top-down); ops-д PDF y (доороос дээш) болгож хөрвүүлнэ
  let top = margin;

  const place = (lines: string[], x: number, baselineTop: number, size: number, lineHeight: number, bold: boolean, color: Color): void => {
    const font = bold ? fonts.bold : fonts.regular;
    lines.forEach((text, i) => {
      ops.push({ kind: 'text', text, x, y: H - (baselineTop + i * lineHeight), size, bold, color, width: font.widthOfTextAtSize(text, size) });
    });
  };
  // Мөрийн хайрцагны дотор baseline-ийн босоо байрлал
  const baselineOf = (lineTop: number, size: number, lineHeight: number): number => lineTop + (lineHeight - size) / 2 + size * 0.8;
  const rule = (x1: number, x2: number, thickness: number, color: Color): void => {
    ops.push({ kind: 'rule', x1, x2, y: H - top, thickness, color });
  };

  // Гарчиг
  const titleSize = 15 * s;
  const titleLH = 20 * s;
  const titleLines = wrapText(SIGNATURE_PAGE_TITLE, fonts.bold, titleSize, columnWidth);
  place(titleLines, left, baselineOf(top, titleSize, titleLH), titleSize, titleLH, true, ACCENT);
  top += titleLines.length * titleLH + 6 * s;
  rule(left, right, 1.5 * s, ACCENT);
  top += 16 * s;

  // QR + заавар
  const qrSize = QR_SIZE_PT * s;
  const stacked = columnWidth - qrSize - QR_GAP_PT * s < MIN_HINT_WIDTH_PT * s;
  const hintWidth = stacked ? columnWidth : columnWidth - qrSize - QR_GAP_PT * s;
  const headingSize = 10.5 * s;
  const headingLH = 14 * s;
  const bodySize = 9 * s;
  const bodyLH = 12.5 * s;
  const headingLines = wrapText(HINT_HEADING, fonts.bold, headingSize, hintWidth);
  const bodyLines = wrapText(HINT_BODY, fonts.regular, bodySize, hintWidth);
  place(headingLines, left, baselineOf(top, headingSize, headingLH), headingSize, headingLH, true, INK);
  const bodyTop = top + headingLines.length * headingLH + 4 * s;
  place(bodyLines, left, baselineOf(bodyTop, bodySize, bodyLH), bodySize, bodyLH, false, MUTED);
  const hintHeight = bodyTop + bodyLines.length * bodyLH - top;
  if (stacked) {
    top += hintHeight + 8 * s;
    ops.push({ kind: 'qr', x: left + (columnWidth - qrSize) / 2, y: H - (top + qrSize), size: qrSize });
    top += qrSize;
  } else {
    ops.push({ kind: 'qr', x: right - qrSize, y: H - (top + qrSize), size: qrSize });
    top += Math.max(qrSize, hintHeight);
  }
  top += 16 * s;

  // Хүснэгт
  rule(left, right, 0.8 * s, RULE_STRONG);
  const labelWidth = columnWidth * LABEL_COLUMN_RATIO;
  const valueX = left + labelWidth + COLUMN_GAP_PT * s;
  const valueWidth = columnWidth - labelWidth - COLUMN_GAP_PT * s;
  const labelSize = 8.5 * s;
  const labelLH = labelSize * 1.35;
  for (const row of content.rows) {
    const bold = row.bold ?? false;
    const valueSize = (row.size ?? 9.5) * s;
    const valueLH = valueSize * 1.35;
    const valueFont = bold ? fonts.bold : fonts.regular;
    const labelLines = wrapText(row.label, fonts.regular, labelSize, labelWidth);
    const valueLines = capLines(row.lines.flatMap((line) => wrapText(line, valueFont, valueSize, valueWidth)), maxValueLines, valueFont, valueSize, valueWidth);
    const firstBaseline = baselineOf(top + ROW_PAD_PT * s, valueSize, valueLH);
    place(labelLines, left, firstBaseline, labelSize, labelLH, false, MUTED);
    place(valueLines, valueX, firstBaseline, valueSize, valueLH, bold, INK);
    top += Math.max(labelLines.length * labelLH, valueLines.length * valueLH) + 2 * ROW_PAD_PT * s;
    // Эрт гарна: энэ масштабад багтахгүй нь тодорхой болсон бол үлдсэн мөрүүдийг хэмжих шаардлагагүй
    if (top > limit) return null;
    rule(left, right, 0.5 * s, RULE_LIGHT);
  }

  // Анхааруулга
  top += 14 * s;
  const noteSize = 8 * s;
  const noteLH = 11.5 * s;
  if (content.mock) {
    const mockLines = wrapText(MOCK_DISCLAIMER, fonts.bold, noteSize, columnWidth);
    place(mockLines, left, baselineOf(top, noteSize, noteLH), noteSize, noteLH, true, ALERT);
    top += mockLines.length * noteLH + 6 * s;
  }
  const noteLines = wrapText(DISCLAIMER, fonts.regular, noteSize, columnWidth);
  place(noteLines, left, baselineOf(top, noteSize, noteLH), noteSize, noteLH, false, MUTED);
  top += noteLines.length * noteLH;

  return top <= limit ? { width: W, height: H, scale: s, column: { left, right }, ops } : null;
}

export function drawSignaturePage(page: PDFPage, layout: SignaturePageLayout, resources: StampFonts & { qrImage: PDFImage }): void {
  for (const op of layout.ops) {
    switch (op.kind) {
      case 'text':
        page.drawText(op.text, { x: op.x, y: op.y, size: op.size, font: op.bold ? resources.bold : resources.regular, color: op.color });
        break;
      case 'rule':
        page.drawLine({ start: { x: op.x1, y: op.y }, end: { x: op.x2, y: op.y }, thickness: op.thickness, color: op.color });
        break;
      case 'qr':
        page.drawImage(resources.qrImage, { x: op.x, y: op.y, width: op.size, height: op.size });
        break;
    }
  }
}
