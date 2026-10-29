import { PDFDocument, PDFName, PDFNumber, degrees } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { createPageFrame, intersectBoxes, normalizeBox, normalizeRotation, readPageGeometry, type QuarterTurn } from './page-frame';
import { userToVisual } from './pdf-inspect';

describe('normalizeBox / intersectBoxes', () => {
  it('эсрэг диагональ цэгээр өгсөн (сөрөг өргөн/өндөр) хайрцгийг эерэг болгоно', () => {
    expect(normalizeBox({ x: 595, y: 842, width: -595, height: -842 })).toEqual({ x: 0, y: 0, width: 595, height: 842 });
  });

  it('огтлолцол, огтлолцохгүй бол null', () => {
    expect(intersectBoxes({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 20, width: 100, height: 100 })).toEqual({ x: 50, y: 20, width: 50, height: 80 });
    expect(intersectBoxes({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBeNull();
  });
});

describe('normalizeRotation', () => {
  it.each([
    [0, 0],
    [90, 90],
    [180, 180],
    [270, 270],
    [-90, 270],
    [450, 90],
    [360, 0],
    [45, 0],
    [90.5, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])('%s → %s', (input, expected) => {
    expect(normalizeRotation(input)).toBe(expected);
  });
});

describe('createPageFrame', () => {
  const visible = { x: 10, y: 20, width: 100, height: 200 };

  it('харагдах хэмжээ: 90/270-д өргөн, өндөр солигдоно', () => {
    expect([0, 180].map((r) => createPageFrame(visible, r as QuarterTurn).width)).toEqual([100, 100]);
    expect([90, 270].map((r) => createPageFrame(visible, r as QuarterTurn).width)).toEqual([200, 200]);
    expect(createPageFrame(visible, 90).height).toBe(100);
  });

  // PDF spec: /Rotate=R хуудсыг цагийн зүүн тийш R° эргүүлж харуулна. Булангууд:
  it('0°: харагдах зүүн доод = user зүүн доод', () => {
    const f = createPageFrame(visible, 0);
    expect(f.toUser(0, 0)).toEqual({ x: 10, y: 20 });
    expect(f.toUser(100, 200)).toEqual({ x: 110, y: 220 });
  });

  it('90°: харагдах зүүн доод = user баруун доод; зүүн дээд = user зүүн доод; баруун доод = user баруун дээд', () => {
    const f = createPageFrame(visible, 90);
    expect(f.toUser(0, 0)).toEqual({ x: 110, y: 20 });
    expect(f.toUser(0, 100)).toEqual({ x: 10, y: 20 });
    expect(f.toUser(200, 0)).toEqual({ x: 110, y: 220 });
  });

  it('180°: харагдах зүүн доод = user баруун дээд', () => {
    expect(createPageFrame(visible, 180).toUser(0, 0)).toEqual({ x: 110, y: 220 });
  });

  it('270°: харагдах зүүн доод = user зүүн дээд; баруун доод = user зүүн доод', () => {
    const f = createPageFrame(visible, 270);
    expect(f.toUser(0, 0)).toEqual({ x: 10, y: 220 });
    expect(f.toUser(200, 0)).toEqual({ x: 10, y: 20 });
  });

  it.each([0, 90, 180, 270] as const)('%s°: spec-ээс гаргасан урвуу хөрвүүлэлттэй (userToVisual) нийцнэ, босоо чиглэл хадгалагдана', (rotation) => {
    const frame = createPageFrame(visible, rotation);
    for (const point of [
      [0, 0],
      [13.5, 7.25],
      [frame.width, frame.height],
      [frame.width / 3, frame.height * 0.9],
    ] as const) {
      const user = frame.toUser(point[0], point[1]);
      const back = userToVisual([user.x, user.y], visible, rotation);
      expect(back[0]).toBeCloseTo(point[0], 9);
      expect(back[1]).toBeCloseTo(point[1], 9);
    }
    // frame.rotation чиглэлд зурсан текстийн baseline харагдахад (1,0) байх ёстой
    const rad = (frame.rotation * Math.PI) / 180;
    const [dx, dy] = [Math.cos(rad), Math.sin(rad)];
    const origin = frame.toUser(0, 0);
    const [vx0, vy0] = userToVisual([origin.x, origin.y], visible, rotation);
    const [vx1, vy1] = userToVisual([origin.x + dx, origin.y + dy], visible, rotation);
    expect(vx1 - vx0).toBeCloseTo(1, 9);
    expect(vy1 - vy0).toBeCloseTo(0, 9);
  });
});

describe('readPageGeometry', () => {
  async function onePage(configure: (page: ReturnType<PDFDocument['addPage']>, doc: PDFDocument) => void) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    configure(page, doc);
    return page;
  }

  it('MediaBox ба эргэлтийг уншина', async () => {
    const page = await onePage((p) => p.setRotation(degrees(90)));
    expect(readPageGeometry(page)).toEqual({ visible: { x: 0, y: 0, width: 600, height: 800 }, rotation: 90 });
  });

  it('харагдах талбар = CropBox ∩ MediaBox (CropBox MediaBox-оос томорвол клиплэнэ)', async () => {
    const page = await onePage((p) => {
      p.setMediaBox(100, 50, 600, 800);
      p.setCropBox(0, 0, 400, 500);
    });
    expect(readPageGeometry(page).visible).toEqual({ x: 100, y: 50, width: 300, height: 450 });
  });

  it('эсрэг диагональ MediaBox-ыг зөв унших', async () => {
    const page = await onePage((p) => p.node.set(PDFName.of('MediaBox'), p.doc.context.obj([600, 800, 0, 0])));
    expect(readPageGeometry(page).visible).toEqual({ x: 0, y: 0, width: 600, height: 800 });
  });

  it('эцэг Pages зангилаанаас өвлөгдсөн MediaBox/Rotate-ийг тооцно', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    const pages = doc.catalog.Pages();
    pages.set(PDFName.of('MediaBox'), doc.context.obj([0, 0, 300, 400]));
    pages.set(PDFName.of('Rotate'), PDFNumber.of(270));
    page.node.delete(PDFName.of('MediaBox'));
    expect(readPageGeometry(page)).toEqual({ visible: { x: 0, y: 0, width: 300, height: 400 }, rotation: 270 });
  });

  it('/Rotate 90-ийн язгуур биш бол 0 гэж үзнэ', async () => {
    const page = await onePage((p) => p.node.set(PDFName.of('Rotate'), PDFNumber.of(45)));
    expect(readPageGeometry(page).rotation).toBe(0);
  });

  it('хоосон харагдах талбар (CropBox MediaBox-той огтлолцохгүй) эсвэл тэг хэмжээтэй MediaBox → алдаа', async () => {
    const disjoint = await onePage((p) => p.setCropBox(1000, 1000, 10, 10));
    expect(() => readPageGeometry(disjoint)).toThrow('empty visible area');
    const zero = await onePage((p) => p.setMediaBox(0, 0, 0, 0));
    expect(() => readPageGeometry(zero)).toThrow('empty visible area');
  });
});
