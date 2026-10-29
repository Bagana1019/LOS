// FR-11.4 Хуудасны харагдах талбар ба /Rotate-ийг тооцож "харагдах" (displayed) координатыг PDF-ийн user space руу буулгана.
// Штамп зурахдаа бид үргэлж харагдах хуудасны зүүн доод буланг (0,0) гэж үзэж зурна; хуудас 90/180/270° эргэсэн, CropBox-тай,
// MediaBox-ын эхлэл нь (0,0) биш байсан ч QR/тайлбар хэрэглэгчид босоо, баруун доод буланд харагдана.
import type { PDFPage } from 'pdf-lib';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type QuarterTurn = 0 | 90 | 180 | 270;

/** PDF нь тэгш өнцөгтийг эсрэг диагональ хоёр цэгээр зааж болдог — өргөн/өндрийг эерэг болгоно. */
export function normalizeBox(box: Box): Box {
  return {
    x: Math.min(box.x, box.x + box.width),
    y: Math.min(box.y, box.y + box.height),
    width: Math.abs(box.width),
    height: Math.abs(box.height),
  };
}

export function intersectBoxes(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.min(a.y + a.height, b.y + b.height);
  return right > x && top > y ? { x, y, width: right - x, height: top - y } : null;
}

/** /Rotate нь 90-ийн язгуур байх ёстой; сөрөг/360+ утгыг нормчилно, ойлгомжгүй утгыг (viewer-үүд мэт) 0 гэж үзнэ. */
export function normalizeRotation(angle: number): QuarterTurn {
  if (!Number.isInteger(angle) || angle % 90 !== 0) return 0;
  return (((angle % 360) + 360) % 360) as QuarterTurn;
}

export interface PageFrame {
  /** Харагдах хуудасны хэмжээ (эргэлтийг тооцсон) */
  readonly width: number;
  readonly height: number;
  /** Харагдах босоо байдлыг хадгалахын тулд user space-д зурах бүх зүйлд өгөх эргэлт (CCW градус) */
  readonly rotation: QuarterTurn;
  /** Харагдах координат (эх нь харагдах хуудасны зүүн доод булан, y дээшээ) → user space координат */
  toUser(visualX: number, visualY: number): { x: number; y: number };
}

export function createPageFrame(visible: Box, rotation: QuarterTurn): PageFrame {
  const { x: cx, y: cy, width: cw, height: ch } = visible;
  const swapped = rotation === 90 || rotation === 270;
  return {
    width: swapped ? ch : cw,
    height: swapped ? cw : ch,
    rotation,
    toUser(vx, vy) {
      switch (rotation) {
        case 0:
          return { x: cx + vx, y: cy + vy };
        case 90:
          return { x: cx + cw - vy, y: cy + vx };
        case 180:
          return { x: cx + cw - vx, y: cy + ch - vy };
        case 270:
          return { x: cx + vy, y: cy + ch - vx };
      }
    },
  };
}

export interface PageGeometry {
  visible: Box;
  rotation: QuarterTurn;
}

/** Хуудасны харагдах талбар = MediaBox ∩ CropBox, мөн /Rotate (өвлөгдсөн атрибутыг оруулан). Бүтэц эвдэрсэн бол pdf-lib шидэнэ. */
export function readPageGeometry(page: PDFPage): PageGeometry {
  const media = normalizeBox(page.getMediaBox());
  const cropNode = page.node.CropBox();
  const visible = cropNode ? intersectBoxes(media, normalizeBox(cropNode.asRectangle())) : media;
  if (!visible || !(visible.width > 0 && visible.height > 0 && Number.isFinite(visible.width) && Number.isFinite(visible.height))) {
    throw new Error('page has an empty visible area');
  }
  return { visible, rotation: normalizeRotation(page.getRotation().angle) };
}
