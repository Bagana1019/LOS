// FR-11.4 Хуудас бүрийн штамп: баруун доод буланд жижиг QR (~18 мм) + нэг мөр тайлбар, mock үед диагонал "ТЕСТ — ХҮЧИНГҮЙ" ус тэмдэг.
// planPageStamp() нь цэвэр тооцоолол (харагдах координат), drawPageStamp() нь pdf-lib руу зурна (PageFrame-ээр user space руу буулгана).
import { degrees, grayscale, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { mm } from './format';
import type { PageFrame } from './page-frame';
import { fitText } from './text-layout';

export const WATERMARK_TEXT = 'ТЕСТ — ХҮЧИНГҮЙ';
export const CAPTION_LABEL = 'Цахим гарын үсэг';

const QR_SIZE_PT = mm(18);
const MARGIN_PT = mm(8);
const CAPTION_MAX_SIZE_PT = 7;
const CAPTION_MIN_SIZE_PT = 4;
/** Масштабаас үл хамааран тайлбарын хамгийн жижиг үсэг (pt) — үүнээс жижиг нь хэнд ч уншигдахгүй */
const CAPTION_FLOOR_PT = 3;
const CAPTION_MAX_LINES = 3;
const CAPTION_GAP_PT = 4;
/** Энэ хэмжээнээс жижиг хуудсанд штампыг харьцаагаар багасгана (A5 хүртэл бүтэн хэмжээ) */
const FULL_SIZE_REFERENCE_PT = 360;
const CAP_HEIGHT_EM = 0.73;
const WATERMARK_MAX_SIZE_PT = 96;
const CAPTION_COLOR = grayscale(0.25);
const WATERMARK_COLOR = grayscale(0.45);
const WATERMARK_OPACITY = 0.18;

export interface StampFonts {
  regular: PDFFont;
  bold: PDFFont;
}

export interface CaptionLine {
  text: string;
  /** Мөрийн эхлэл (зүүн) x, baseline y — харагдах координат */
  x: number;
  y: number;
}
export interface PageStampPlan {
  qr: { x: number; y: number; size: number };
  caption: { size: number; lines: CaptionLine[] } | null;
  watermark: WatermarkPlan | null;
}
export interface WatermarkPlan {
  text: string;
  size: number;
  x: number;
  y: number;
  /** Харагдах хуудасны хувьд чиглэл (CCW градус) */
  angle: number;
}

/** Хуудас бүрийн диагональ ус тэмдэг: хуудасны төвд, булан-булан чиглэлд, хуудсанд бүрэн багтана. */
export function planWatermark(width: number, height: number, bold: PDFFont): WatermarkPlan {
  const angleRad = Math.atan2(height, width);
  const [cos, sin] = [Math.cos(angleRad), Math.sin(angleRad)];
  const unitWidth = bold.widthOfTextAtSize(WATERMARK_TEXT, 1);
  // Эргэсэн текстийн bounding box хуудасны 90%-д багтах хамгийн том хэмжээ
  const size = Math.min(
    WATERMARK_MAX_SIZE_PT,
    (0.9 * width) / (unitWidth * cos + CAP_HEIGHT_EM * sin),
    (0.9 * height) / (unitWidth * sin + CAP_HEIGHT_EM * cos),
  );
  const length = unitWidth * size;
  const halfCap = (CAP_HEIGHT_EM * size) / 2;
  return {
    text: WATERMARK_TEXT,
    size,
    // Текстийн төвийг (width/2, height/2)-д тулгана: baseline-ийн эхлэл = төв − (урт/2)·u − (капын өндөр/2)·n
    x: width / 2 - (length / 2) * cos + halfCap * sin,
    y: height / 2 - (length / 2) * sin - halfCap * cos,
    angle: (angleRad * 180) / Math.PI,
  };
}

export function planPageStamp(width: number, height: number, captionText: string, fonts: StampFonts, mock: boolean): PageStampPlan {
  const shortSide = Math.min(width, height);
  const scale = Math.min(1, Math.max(0.2, shortSide / FULL_SIZE_REFERENCE_PT));
  // Маш жижиг хуудсанд ч QR/зай хуудсаас гарахгүй
  const qrSize = Math.min(QR_SIZE_PT * scale, shortSide * 0.4);
  const margin = Math.min(MARGIN_PT * scale, shortSide * 0.08);
  const qr = { x: width - margin - qrSize, y: margin, size: qrSize };

  const captionRight = qr.x - CAPTION_GAP_PT * scale;
  const captionWidth = captionRight - margin;
  const minSize = Math.max(CAPTION_FLOOR_PT, CAPTION_MIN_SIZE_PT * scale);
  let caption: PageStampPlan['caption'] = null;
  // Тайлбар багтах зай (≈ 12 үсэг) байхгүй бол орхино — QR өөрөө код/URL-ийг агуулдаг
  if (captionWidth >= 12 * minSize) {
    const fitted = fitText(captionText, fonts.regular, {
      maxSize: CAPTION_MAX_SIZE_PT * scale,
      minSize,
      maxWidth: captionWidth,
      maxLines: CAPTION_MAX_LINES,
    });
    const lineHeight = fitted.size * 1.3;
    const centerY = qr.y + qrSize / 2;
    caption = {
      size: fitted.size,
      lines: fitted.lines.map((text, i) => ({
        text,
        x: captionRight - fonts.regular.widthOfTextAtSize(text, fitted.size),
        // Мөрүүдийг QR-ийн босоо төвд тэгшлэнэ (баруун талаар тэгшилсэн)
        y: centerY + ((fitted.lines.length - 1) / 2 - i) * lineHeight - fitted.size * 0.35,
      })),
    };
  }
  return { qr, caption, watermark: mock ? planWatermark(width, height, fonts.bold) : null };
}

export function drawWatermark(page: PDFPage, frame: PageFrame, plan: WatermarkPlan, bold: PDFFont): void {
  const origin = frame.toUser(plan.x, plan.y);
  page.drawText(plan.text, {
    x: origin.x,
    y: origin.y,
    size: plan.size,
    font: bold,
    color: WATERMARK_COLOR,
    // Тунгалаг тул доорх гэрээний текст уншигдсаар үлдэнэ
    opacity: WATERMARK_OPACITY,
    rotate: degrees(frame.rotation + plan.angle),
  });
}

function drawQr(page: PDFPage, frame: PageFrame, qrImage: PDFImage, qr: PageStampPlan['qr']): void {
  const origin = frame.toUser(qr.x, qr.y);
  page.drawImage(qrImage, { x: origin.x, y: origin.y, width: qr.size, height: qr.size, rotate: degrees(frame.rotation) });
}

/** Усан тэмдэг (mock) → QR → тайлбар. Хуудасны одоо байгаа агуулгыг өөрчлөхгүй, зөвхөн төгсгөлд нь нэмнэ. */
export function drawPageStamp(page: PDFPage, frame: PageFrame, plan: PageStampPlan, resources: StampFonts & { qrImage: PDFImage }): void {
  if (plan.watermark) drawWatermark(page, frame, plan.watermark, resources.bold);
  drawQr(page, frame, resources.qrImage, plan.qr);
  if (!plan.caption) return;
  for (const line of plan.caption.lines) {
    const origin = frame.toUser(line.x, line.y);
    page.drawText(line.text, {
      x: origin.x,
      y: origin.y,
      size: plan.caption.size,
      font: resources.regular,
      color: CAPTION_COLOR,
      rotate: degrees(frame.rotation),
    });
  }
}
