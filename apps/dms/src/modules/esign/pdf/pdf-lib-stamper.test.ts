import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { degrees, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, type PDFFont } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InvalidPdfError } from '../ports/pdf-stamper.port';
import { mm } from './format';
import type { QuarterTurn } from './page-frame';
import { PdfLibStamper } from './pdf-lib-stamper';
import {
  expectedQrMatrix,
  extractImages,
  extractTextRuns,
  loadMeasureFonts,
  pageContentStreams,
  pageOperations,
  pageText,
  readAttachments,
  readQrMatrix,
  transformPoint,
  transformVector,
  userToVisual,
  userToVisualVector,
  visualSize,
  type PageImage,
  type Point,
  type Rect,
} from './pdf-inspect';
import { CMS_BYTES, GROUPED_CODE, SIGNED_AT, VERIFY_URL, sampleStampInput } from './test-fixtures';
import { A4_SIZE, createSamplePdf } from './test-utils';

const WATERMARK = 'ТЕСТ — ХҮЧИНГҮЙ';
const CAPTION = `Цахим гарын үсэг · ГЭР-2026-000123 · ${GROUPED_CODE}`;
const SIGNER = 'Өлзийбат Үүрцайх';
const A4_VISIBLE: Rect = { x: 0, y: 0, width: A4_SIZE[0], height: A4_SIZE[1] };
const EPS = 1e-3;

const stamper = new PdfLibStamper();
/** pdf-lib ачаалахдаа Producer/ModDate-ийг санах ойд "одоо"-оор дардаг — гаралтын metadata-г шалгахад унтраана */
const loadOutput = (bytes: Buffer): Promise<PDFDocument> => PDFDocument.load(bytes, { updateMetadata: false });
let measure: { regular: PDFFont; bold: PDFFont };
beforeAll(async () => {
  measure = await loadMeasureFonts();
});

// ---- Харагдах координатын туслахууд (user space → харагдах хуудас, spec-ээс гаргасан) ----

interface VisualQr {
  left: number;
  right: number;
  bottom: number;
  top: number;
  /** Зургийн x/y тэнхлэг харагдах хуудсан дээр: x нь баруун, y нь дээш (толин тусгалгүй, босоо) эсэх */
  upright: boolean;
}
function visualQr(image: PageImage, visible: Rect, rotation: QuarterTurn): VisualQr {
  const corners = ([[0, 0], [1, 0], [0, 1], [1, 1]] as Point[]).map((p) => userToVisual(transformPoint(image.matrix, p), visible, rotation));
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const xAxis = userToVisualVector(transformVector(image.matrix, [1, 0]), rotation);
  const yAxis = userToVisualVector(transformVector(image.matrix, [0, 1]), rotation);
  const upright = xAxis[0] > 0 && Math.abs(xAxis[1]) < EPS && yAxis[1] > 0 && Math.abs(yAxis[0]) < EPS;
  return { left: Math.min(...xs), right: Math.max(...xs), bottom: Math.min(...ys), top: Math.max(...ys), upright };
}

interface VisualRun {
  text: string;
  size: number;
  baseFont: string;
  origin: Point;
  direction: Point;
  /** Зөвхөн босоо (direction ≈ (1,0)) мөрийн өргөн */
  width: number;
}
function visualRuns(doc: PDFDocument, pageIndex: number, visible: Rect, rotation: QuarterTurn): VisualRun[] {
  return extractTextRuns(doc, doc.getPage(pageIndex)).map((run) => {
    const bold = /Bold/.test(run.baseFont);
    return {
      text: run.text,
      size: run.size,
      baseFont: run.baseFont,
      origin: userToVisual(run.origin, visible, rotation),
      direction: userToVisualVector(run.direction, rotation),
      width: (bold ? measure.bold : measure.regular).widthOfTextAtSize(run.text, run.size),
    };
  });
}
const isHorizontal = (run: VisualRun): boolean => run.direction[0] > 1 - EPS;

/** Штампын шрифтийн нэр (`LOSDMS+…`) — эх баримтын өөрийн текстээс штампын мөрүүдийг ялгана */
const isStampRun = (run: VisualRun): boolean => run.baseFont.startsWith('LOSDMS+');

/** Хуудас бүрт: QR хуудсанд багтсан, босоо; штампын босоо мөр бүр (эх агуулгыг оролцуулахгүй) хуудсаас гарахгүй */
function expectInsidePage(doc: PDFDocument, pageIndex: number, visible: Rect, rotation: QuarterTurn): void {
  const { width, height } = visualSize(visible, rotation);
  const [image] = extractImages(doc, doc.getPage(pageIndex));
  const qr = visualQr(image, visible, rotation);
  expect(qr.upright).toBe(true);
  expect(qr.left).toBeGreaterThanOrEqual(-EPS);
  expect(qr.bottom).toBeGreaterThanOrEqual(-EPS);
  expect(qr.right).toBeLessThanOrEqual(width + EPS);
  expect(qr.top).toBeLessThanOrEqual(height + EPS);
  for (const run of visualRuns(doc, pageIndex, visible, rotation).filter((r) => isStampRun(r) && isHorizontal(r))) {
    expect(run.origin[0]).toBeGreaterThanOrEqual(-EPS);
    expect(run.origin[0] + run.width).toBeLessThanOrEqual(width + EPS);
    expect(run.origin[1]).toBeGreaterThanOrEqual(-EPS);
    expect(run.origin[1] + run.size).toBeLessThanOrEqual(height + EPS);
  }
}

describe('PdfLibStamper: гаралтын бүтэц', () => {
  let sample: Buffer;
  let stamped: Buffer;
  let doc: PDFDocument;
  let sourceDoc: PDFDocument;
  beforeAll(async () => {
    sample = await createSamplePdf({ pages: 3 });
    stamped = await stamper.stamp(sampleStampInput(sample, { signerName: SIGNER }));
    doc = await loadOutput(stamped);
    sourceDoc = await loadOutput(sample);
  });

  it('PDF-ээр дахин ачаалагдаж, хуудасны тоо = эх + 1, эх хуудсуудын хэмжээ хэвээр, сүүлийн хуудас = эхний хуудасны хэмжээ', () => {
    expect(stamped.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(doc.getPageCount()).toBe(sourceDoc.getPageCount() + 1);
    sourceDoc.getPages().forEach((page, i) => expect(doc.getPage(i).getSize()).toEqual(page.getSize()));
    const last = doc.getPage(doc.getPageCount() - 1);
    expect(last.getSize()).toEqual(sourceDoc.getPage(0).getSize());
    expect(last.getRotation().angle).toBe(0);
  });

  it('хуудас бүр (гарын үсгийн хуудас ч) нэг л QR зураг агуулж, нэг embed-ийг дахин ашиглана', () => {
    const refs = doc.getPages().map((page) => {
      const images = extractImages(doc, page);
      expect(images).toHaveLength(1);
      return images[0].ref.toString();
    });
    expect(new Set(refs).size).toBe(1);
  });

  it('QR зургийн модулийн матриц verifyUrl-ийн QR (алдаа засалт M)-тэй яг тэнцүү', () => {
    const [image] = extractImages(doc, doc.getPage(0));
    expect(readQrMatrix(image)).toEqual(expectedQrMatrix(VERIFY_URL));
    expect(readQrMatrix(image)).not.toEqual(expectedQrMatrix(`${VERIFY_URL}X`));
  });

  it('жижиг QR ≈ 18 мм, баруун доод буланд захаас 8 мм; гарын үсгийн хуудсан дахь том QR ≈ 40 мм', () => {
    for (let i = 0; i < 3; i++) {
      const qr = visualQr(extractImages(doc, doc.getPage(i))[0], A4_VISIBLE, 0);
      expect(qr.upright).toBe(true);
      expect(qr.right - qr.left).toBeCloseTo(mm(18), 3);
      expect(qr.top - qr.bottom).toBeCloseTo(mm(18), 3);
      expect(qr.right).toBeCloseTo(A4_SIZE[0] - mm(8), 3);
      expect(qr.bottom).toBeCloseTo(mm(8), 3);
    }
    const big = visualQr(extractImages(doc, doc.getPage(3))[0], A4_VISIBLE, 0);
    expect(big.right - big.left).toBeCloseTo(mm(40), 3);
    expect(big.upright).toBe(true);
  });

  it('хуудас бүрт нэг мөр тайлбар зөв агуулгатай: 7pt, босоо, QR-ийн зүүн талд баруун тийш тэгшилсэн', () => {
    for (let i = 0; i < 3; i++) {
      const qr = visualQr(extractImages(doc, doc.getPage(i))[0], A4_VISIBLE, 0);
      const captions = visualRuns(doc, i, A4_VISIBLE, 0).filter((run) => run.text.startsWith('Цахим гарын үсэг'));
      expect(captions).toHaveLength(1);
      const [caption] = captions;
      expect(caption.text).toBe(CAPTION);
      expect(caption.size).toBeCloseTo(7, 6);
      expect(isHorizontal(caption)).toBe(true);
      expect(caption.origin[0] + caption.width).toBeLessThanOrEqual(qr.left);
      expect(caption.origin[0] + caption.width).toBeGreaterThan(qr.left - 6);
      expect(caption.origin[1]).toBeGreaterThan(qr.bottom);
      expect(caption.origin[1]).toBeLessThan(qr.top);
    }
  });

  it('гарын үсгийн хуудас: гарчиг, шошго, утгууд (Ө Ү үсэгтэй нэр, далдалсан регистр, огноо UTC+8 + UTC, SHA-256 хоёр мөр, код, URL, анхааруулга)', () => {
    const texts = pageText(doc, doc.getPage(3));
    const input = sampleStampInput(sample, { signerName: SIGNER });
    const sha = input.originalSha256;
    for (const expected of [
      'ЦАХИМ ГАРЫН ҮСГИЙН ХУУДАС',
      'Гэрээний дугаар',
      'ГЭР-2026-000123',
      'Гарын үсэг зурсан',
      SIGNER,
      'Регистр',
      'УА****5678',
      'Үйлчилгээ үзүүлэгч',
      'Tridum',
      'Гэрчилгээ олгогч',
      'LOS MOCK CA (ТЕСТ)',
      'Гэрчилгээний сериал',
      '4A:3F:00:9C:11:7E:22:B5',
      'Гэрчилгээ хүчинтэй хугацаа',
      '2026-01-01 08:00:00 – 2028-01-01 08:00:00 (UTC+8)',
      'Гарын үсэг зурсан огноо',
      '2026-10-28 11:15:42 (UTC+8)',
      '2026-10-28T03:15:42.000Z (UTC)',
      'Баримтын SHA-256 (эх хувь)',
      sha.slice(0, 32),
      sha.slice(32),
      'Баталгаажуулах код',
      GROUPED_CODE,
      'Баталгаажуулах хаяг',
      VERIFY_URL,
    ]) {
      expect(texts).toContain(expected);
    }
    expect(texts.some((text) => text.startsWith('Энэхүү хуудас нь'))).toBe(true);
    expect(texts.some((text) => text.startsWith('АНХААРУУЛГА: ТЕСТ ГАРЫН ҮСЭГ'))).toBe(true);
  });

  it('PDF metadata: гарчиг, producer, түлхүүр үг (код + анхны sha256), үүсгэсэн/өөрчилсөн огноо = signedAt', () => {
    const { originalSha256 } = sampleStampInput(sample);
    expect(doc.getTitle()).toBe('ГЭР-2026-000123 — гарын үсэгтэй');
    expect(doc.getProducer()).toBe('LOS Radix DMS');
    const keywords = doc.getKeywords() ?? '';
    expect(keywords).toContain(`verification:${GROUPED_CODE}`);
    expect(keywords).toContain(`sha256:${originalSha256}`);
    expect(doc.getCreationDate()?.toISOString()).toBe(SIGNED_AT.toISOString());
    expect(doc.getModificationDate()?.toISOString()).toBe(SIGNED_AT.toISOString());
    // Эх баримтын Creator/Author зэрэг бусад талбарыг дарахгүй
    expect(doc.getCreator()).toBe(sourceDoc.getCreator());
    expect(doc.getAuthor()).toBe(sourceDoc.getAuthor());
  });

  it('signature.p7s хавсралт бай, CMS bytes яг ижил, эх баримтын хэшийг тайлбарт заасан', () => {
    const attachments = readAttachments(doc);
    expect(attachments.map((a) => a.name)).toEqual(['signature.p7s']);
    expect(attachments[0].bytes.equals(CMS_BYTES)).toBe(true);
    expect(attachments[0].mimeType).toBe('application/pkcs7-signature');
  });

  it('эх баримтын хуудасны агуулга (content stream) bytes-аараа өөрчлөгдөхгүй, зөвхөн q…Q-д ороож төгсгөлд нь штамп нэмнэ', () => {
    sourceDoc.getPages().forEach((sourcePage, i) => {
      const [original] = pageContentStreams(sourceDoc, sourcePage);
      const output = pageContentStreams(doc, doc.getPage(i));
      const at = output.indexOf(original);
      expect(at).toBeGreaterThanOrEqual(1);
      expect(output[at - 1].trim()).toBe('q');
      expect(output[at + 1].trim()).toBe('Q');
      expect(output.length).toBeGreaterThan(at + 2); // штамп төгсгөлд
      // Эх фонт/нөөцүүд хэвээр
      const fonts = (page: typeof sourcePage) => page.node.Resources()!.lookup(PDFName.of('Font'), PDFDict).keys().map((key) => key.decodeText());
      expect(fonts(doc.getPage(i))).toEqual(expect.arrayContaining(fonts(sourcePage)));
    });
  });
});

describe('PdfLibStamper: deterministic', () => {
  it('ижил оролт → ижил bytes (дараалсан ба зэрэгцээ дуудлагад), оролтын Buffer өөрчлөгдөхгүй', async () => {
    const sample = await createSamplePdf({ pages: 2 });
    const before = Buffer.from(sample);
    const input = sampleStampInput(sample);
    const [a, b] = await Promise.all([stamper.stamp(input), stamper.stamp(input)]);
    const c = await stamper.stamp(input);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(true);
    expect(sample.equals(before)).toBe(true);
  });

  it('оролт өөрчлөгдвөл гаралт өөрчлөгдөнө (signedAt, verifyUrl, mock)', async () => {
    const sample = await createSamplePdf({ pages: 1 });
    const base = await stamper.stamp(sampleStampInput(sample));
    for (const override of [
      { signedAt: new Date(SIGNED_AT.getTime() + 1000) },
      { verifyUrl: `${VERIFY_URL}0` },
      { mock: false },
      { contractNo: 'ГЭР-2026-000124' },
    ]) {
      expect((await stamper.stamp(sampleStampInput(sample, override))).equals(base)).toBe(false);
    }
  });

  it('QR нь дамжуулсан verifyUrl-ийг кодолно (өөр URL → өөр матриц)', async () => {
    const sample = await createSamplePdf({ pages: 1 });
    const url = 'https://sign.example.mn/verify/ABCDEFGHJKMN';
    const doc = await loadOutput(await stamper.stamp(sampleStampInput(sample, { verifyUrl: url, verificationCode: 'ABCDEFGHJKMN' })));
    expect(readQrMatrix(extractImages(doc, doc.getPage(0))[0])).toEqual(expectedQrMatrix(url));
  });
});

describe('PdfLibStamper: mock ба бодит ус тэмдэг', () => {
  let sample: Buffer;
  beforeAll(async () => {
    sample = await createSamplePdf({ pages: 2 });
  });

  it('mock=true: хуудас бүрт (гарын үсгийн хуудас ч) "ТЕСТ — ХҮЧИНГҮЙ" диагонал ус тэмдэг, тунгалаг (ca<1)', async () => {
    const doc = await loadOutput(await stamper.stamp(sampleStampInput(sample, { mock: true })));
    for (let i = 0; i < doc.getPageCount(); i++) {
      const page = doc.getPage(i);
      const watermarks = visualRuns(doc, i, A4_VISIBLE, 0).filter((run) => run.text === WATERMARK);
      expect(watermarks).toHaveLength(1);
      const [dx, dy] = watermarks[0].direction;
      const diagonal = Math.atan2(A4_SIZE[1], A4_SIZE[0]);
      expect(Math.atan2(dy, dx)).toBeCloseTo(diagonal, 3);
      expect(watermarks[0].size).toBeGreaterThan(40);
      const states = pageOperations(doc, page).graphicsStates;
      expect(states).toHaveLength(1);
      const extGState = page.node.Resources()!.lookup(PDFName.of('ExtGState'), PDFDict).lookup(PDFName.of(states[0]), PDFDict);
      expect(extGState.lookup(PDFName.of('ca'), PDFNumber).asNumber()).toBeLessThan(0.5);
    }
  });

  it('mock=false: ус тэмдэг, тунгалаг төлөв, "ТЕСТ ГАРЫН ҮСЭГ" анхааруулга огт байхгүй', async () => {
    const doc = await loadOutput(await stamper.stamp(sampleStampInput(sample, { mock: false })));
    for (let i = 0; i < doc.getPageCount(); i++) {
      expect(pageText(doc, doc.getPage(i)).some((text) => text.includes('ХҮЧИНГҮЙ') || text.includes('ТЕСТ ГАРЫН ҮСЭГ'))).toBe(false);
      expect(pageOperations(doc, doc.getPage(i)).graphicsStates).toEqual([]);
    }
  });
});

describe('PdfLibStamper: эргэлт, CropBox, хэмжээ', () => {
  const orientations: Array<{ name: string; size: readonly [number, number] }> = [
    { name: 'босоо A4', size: A4_SIZE },
    { name: 'хэвтээ A4', size: [A4_SIZE[1], A4_SIZE[0]] },
  ];
  const cases = orientations.flatMap(({ name, size }) => ([0, 90, 180, 270] as const).map((rotation) => ({ name, size, rotation })));

  it.each(cases)('$name, /Rotate=$rotation°: QR/тайлбар/ус тэмдэг харагдах хуудсанд босоо, баруун доод буланд', async ({ size, rotation }) => {
    const source = await createSamplePdf({ pages: 2, size, rotation });
    const doc = await loadOutput(await stamper.stamp(sampleStampInput(source)));
    const visible: Rect = { x: 0, y: 0, width: size[0], height: size[1] };
    const { width, height } = visualSize(visible, rotation);

    for (let i = 0; i < 2; i++) {
      const qr = visualQr(extractImages(doc, doc.getPage(i))[0], visible, rotation);
      expect(qr.upright).toBe(true);
      expect(qr.right - qr.left).toBeCloseTo(mm(18), 3);
      expect(qr.right).toBeCloseTo(width - mm(8), 3);
      expect(qr.bottom).toBeCloseTo(mm(8), 3);

      const runs = visualRuns(doc, i, visible, rotation);
      const caption = runs.find((run) => run.text.startsWith('Цахим гарын үсэг'))!;
      expect(isHorizontal(caption)).toBe(true);
      expect(caption.origin[0] + caption.width).toBeLessThanOrEqual(qr.left);
      expect(caption.origin[1]).toBeGreaterThan(qr.bottom);
      expect(caption.origin[1]).toBeLessThan(qr.top);

      const watermark = runs.find((run) => run.text === WATERMARK)!;
      expect(Math.atan2(watermark.direction[1], watermark.direction[0])).toBeCloseTo(Math.atan2(height, width), 3);
      expectInsidePage(doc, i, visible, rotation);
    }

    // Гарын үсгийн хуудас: эргэлтгүй, эхний хуудасны ХАРАГДАХ хэмжээтэй
    const last = doc.getPage(2);
    expect(last.getRotation().angle).toBe(0);
    expect(last.getSize()).toEqual({ width, height });
    expectInsidePage(doc, 2, { x: 0, y: 0, width, height }, 0);
  });

  it('MediaBox эх нь (0,0) биш + CropBox + /Rotate=90: штамп CropBox-ийн харагдах талбарт', async () => {
    const source = await PDFDocument.load(await createSamplePdf({ pages: 1 }));
    const page = source.getPage(0);
    page.setMediaBox(100, 50, A4_SIZE[0], A4_SIZE[1]);
    page.setCropBox(130, 80, 400, 600);
    page.setRotation(degrees(90));
    const doc = await loadOutput(await stamper.stamp(sampleStampInput(Buffer.from(await source.save()))));
    const visible: Rect = { x: 130, y: 80, width: 400, height: 600 };

    expectInsidePage(doc, 0, visible, 90);
    const qr = visualQr(extractImages(doc, doc.getPage(0))[0], visible, 90);
    expect(qr.right).toBeCloseTo(600 - mm(8), 3);
    expect(qr.bottom).toBeCloseTo(mm(8), 3);
    // Гарын үсгийн хуудас = харагдах хэмжээ (600 × 400), өндөр нь доод хязгаар 420-оос бага тул 420
    expect(doc.getPage(1).getSize()).toEqual({ width: 600, height: 420 });
  });

  it('эцэг Pages зангилаанаас өвлөгдсөн MediaBox/Rotate-тэй, агуулгагүй (/Contents-гүй) хуудсыг штамплана', async () => {
    const source = await PDFDocument.create();
    const page = source.addPage([400, 500]);
    const pages = source.catalog.Pages();
    pages.set(PDFName.of('MediaBox'), source.context.obj([0, 0, 400, 500]));
    pages.set(PDFName.of('Rotate'), PDFNumber.of(90));
    page.node.delete(PDFName.of('MediaBox'));
    const doc = await loadOutput(await stamper.stamp(sampleStampInput(Buffer.from(await source.save()))));

    expect(doc.getPageCount()).toBe(2);
    expectInsidePage(doc, 0, { x: 0, y: 0, width: 400, height: 500 }, 90);
  });

  it('эсрэг диагональ MediaBox [w h 0 0]-той хуудсыг зөв унших', async () => {
    const source = await PDFDocument.load(await createSamplePdf({ pages: 1 }));
    source.getPage(0).node.set(PDFName.of('MediaBox'), source.context.obj([A4_SIZE[0], A4_SIZE[1], 0, 0]));
    const doc = await loadOutput(await stamper.stamp(sampleStampInput(Buffer.from(await source.save()))));
    expectInsidePage(doc, 0, A4_VISIBLE, 0);
    const qr = visualQr(extractImages(doc, doc.getPage(0))[0], A4_VISIBLE, 0);
    expect(qr.right).toBeCloseTo(A4_SIZE[0] - mm(8), 3);
  });

  const odd: Array<[string, readonly [number, number]]> = [
    ['жижиг 120×160 pt', [120, 160]],
    ['маш жижиг 50×50 pt', [50, 50]],
    ['дөрвөлжин 400×400', [400, 400]],
    ['A3', [841.89, 1190.55]],
    ['A0', [2383.94, 3370.39]],
    ['явцуу урт 200×1500', [200, 1500]],
    ['өргөн намхан 1500×200', [1500, 200]],
  ];
  it.each(odd)('%s: штамп ба гарын үсгийн хуудас хуудаснаасаа халихгүй', async (_name, size) => {
    const source = await createSamplePdf({ pages: 2, size });
    const doc = await loadOutput(await stamper.stamp(sampleStampInput(source)));
    const visible: Rect = { x: 0, y: 0, width: size[0], height: size[1] };
    expect(doc.getPageCount()).toBe(3);
    expectInsidePage(doc, 0, visible, 0);
    expectInsidePage(doc, 1, visible, 0);
    const { width, height } = doc.getPage(2).getSize();
    expect(width).toBeGreaterThanOrEqual(300);
    expect(height).toBeGreaterThanOrEqual(420);
    expectInsidePage(doc, 2, { x: 0, y: 0, width, height }, 0);
    expect(readQrMatrix(extractImages(doc, doc.getPage(2))[0])).toEqual(expectedQrMatrix(VERIFY_URL));
  });
});

describe('PdfLibStamper: урт утгууд', () => {
  it('урт нэр/гэрчилгээ/URL/гэрээний дугаар: мөр таслагдаж хуудсаас халихгүй, URL ба хэш тэмдэгт алдагдахгүй', async () => {
    const sample = await createSamplePdf({ pages: 1 });
    const longUrl = `https://sign-portal.example-microfinance.mn/e-sign/public/verify/${'7K3QXM9ZB4TN'.repeat(3)}`;
    const input = sampleStampInput(sample, {
      contractNo: `ГЭР-${'ӨӨ-'.repeat(20)}000123`,
      signerName: 'Өлзийбат-Эрдэнэ Үүрцайхгийн Төмөр-Очирын Бат-Өлзий Хүрэлбаатар Дашдорж-Нямаагийн Мөнхбат',
      providerDisplayName: 'Monpass Цахим Гарын Үсгийн Үйлчилгээ',
      verifyUrl: longUrl,
      certificate: {
        ...sampleStampInput(sample).certificate,
        issuer: 'Монголын Тэргүүлэх Гэрчилгээжүүлэх Байгууллага Улсын Бүртгэлийн Ерөнхий Газар Ө.Ү.Х.Х.К',
        serialNumber: '4A3F009C117E22B5'.repeat(6),
      },
    });
    const doc = await loadOutput(await stamper.stamp(input));
    expectInsidePage(doc, 0, A4_VISIBLE, 0);
    expectInsidePage(doc, 1, A4_VISIBLE, 0);
    const joined = pageText(doc, doc.getPage(1)).join('').replace(/\s/g, '');
    expect(joined).toContain(longUrl);
    expect(joined).toContain(input.certificate.serialNumber);
    expect(joined).toContain(input.contractNo);
    // Тайлбар ≤ 3 мөр
    const captionLines = visualRuns(doc, 0, A4_VISIBLE, 0).filter((run) => run.origin[1] < mm(40) && !run.text.startsWith('Хуудас') && isHorizontal(run));
    expect(captionLines.length).toBeLessThanOrEqual(4); // тайлбар ≤ 3 мөр + "Хуудас i/n" хөл
  });

  it('bidi override / мөр таслагч / zero-width тэмдэгтүүд нэр дээр цэвэрлэгдэнэ', async () => {
    const sample = await createSamplePdf({ pages: 1 });
    const doc = await loadOutput(await stamper.stamp(sampleStampInput(sample, { signerName: '‮нохой‬\n​Болд' })));
    const texts = pageText(doc, doc.getPage(1));
    expect(texts).toContain('нохой Болд');
    const invisible = Array.from(texts.join('')).filter((ch) => {
      const cp = ch.codePointAt(0) as number;
      return (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e);
    });
    expect(invisible).toEqual([]);
  });
});

describe('PdfLibStamper: эх баримтын онцлогууд', () => {
  it('эх баримт дахь хавсралт, холбоос (Link annotation) хадгалагдаж, XMP /Metadata арилна', async () => {
    const source = await PDFDocument.load(await createSamplePdf({ pages: 1 }));
    await source.attach(Buffer.from('docx bytes'), 'contract.docx', { mimeType: 'application/octet-stream' });
    const link = source.context.register(
      source.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 50, 150, 70], Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com') } }),
    );
    source.getPage(0).node.addAnnot(link);
    source.catalog.set(PDFName.of('Metadata'), source.context.register(source.context.stream('<x:xmpmeta>old title</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })));
    const sourceBytes = Buffer.from(await source.save());
    expect((await PDFDocument.load(sourceBytes)).catalog.has(PDFName.of('Metadata'))).toBe(true);

    const doc = await loadOutput(await stamper.stamp(sampleStampInput(sourceBytes)));
    const attachments = readAttachments(doc);
    expect(attachments.map((a) => a.name).sort()).toEqual(['contract.docx', 'signature.p7s']);
    expect(attachments.find((a) => a.name === 'contract.docx')!.bytes.toString()).toBe('docx bytes');
    expect(attachments.find((a) => a.name === 'signature.p7s')!.bytes.equals(CMS_BYTES)).toBe(true);
    const annots = doc.getPage(0).node.Annots() as PDFArray;
    expect(annots.size()).toBe(1);
    expect((annots.lookup(0, PDFDict).get(PDFName.of('Subtype')) as PDFName).decodeText()).toBe('Link');
    expect(doc.catalog.has(PDFName.of('Metadata'))).toBe(false);
  });
});

describe('PdfLibStamper: эх баримтад хуурмаг өөрчлөлт оруулахгүй', () => {
  it('Info dict-гүй эх баримтад pdf-lib-ийн "Creator/Author: pdf-lib" брэнд нэмэгдэхгүй (Producer л LOS Radix DMS)', async () => {
    const bare = await PDFDocument.create({ updateMetadata: false });
    bare.addPage([300, 400]);
    const doc = await loadOutput(await stamper.stamp(sampleStampInput(Buffer.from(await bare.save({ updateFieldAppearances: false })))));
    expect(doc.getCreator()).toBeUndefined();
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.getProducer()).toBe('LOS Radix DMS');
  });

  it('appearance-гүй, кирилл утгатай form талбарыг pdf-lib-ийн Helvetica-аар дахин зурахгүй (WinAnsi алдаа шидэхгүй, widget хэвээр)', async () => {
    const source = await PDFDocument.create({ updateMetadata: false });
    const page = source.addPage([400, 500]);
    const field = source.getForm().createTextField('borrower.name');
    field.addToPage(page, { x: 50, y: 400, width: 200, height: 24 });
    // Утгыг шууд /V-д бичиж, appearance (/AP)-ийг хасна: ийм талбарыг pdf-lib save() үед Helvetica-аар дахин зурахыг оролддог
    field.acroField.setValue(PDFHexString.fromText('Өлзийбат'));
    field.acroField.getWidgets()[0].dict.delete(PDFName.of('AP'));
    const sourceBytes = Buffer.from(await source.save({ updateFieldAppearances: false }));

    const doc = await loadOutput(await stamper.stamp(sampleStampInput(sourceBytes)));
    const widget = doc.getForm().getTextField('borrower.name').acroField.getWidgets()[0];
    expect(widget.getAppearances()?.normal).toBeUndefined();
    expect(doc.getForm().getTextField('borrower.name').getText()).toBe('Өлзийбат');
  });
});

describe('PdfLibStamper: буруу оролт', () => {
  let sample: Buffer;
  beforeAll(async () => {
    sample = await createSamplePdf({ pages: 2 });
  });
  afterEach(() => vi.restoreAllMocks());

  async function expectInvalid(pdf: Buffer, message: RegExp): Promise<void> {
    // pdf-lib эвдэрсэн объект олоход console.warn хийдэг — тестийн гаралтыг цэвэр байлгана
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = await stamper.stamp(sampleStampInput(pdf)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(InvalidPdfError);
    expect((error as InvalidPdfError).name).toBe('InvalidPdfError');
    expect((error as InvalidPdfError).message).toMatch(message);
    // Алдааны мессеж нэр/регистр/дугаарыг агуулахгүй
    expect((error as InvalidPdfError).message).not.toMatch(/Бат-Эрдэнэ|УА|ГЭР-2026/);
  }

  it('PDF биш (HTML, хоосон, header-гүй) → InvalidPdfError', async () => {
    await expectInvalid(Buffer.from('<html><body>not a pdf</body></html>'), /not a PDF/);
    await expectInvalid(Buffer.alloc(0), /not a PDF/);
    await expectInvalid(Buffer.concat([Buffer.alloc(2000, 0x20), sample]), /not a PDF/); // header эхний 1024 байтаас хойно
  });

  it('header-тэй боловч эвдэрсэн/таслагдсан/хог → InvalidPdfError', async () => {
    await expectInvalid(Buffer.from('%PDF-1.7\n'), /unreadable|corrupt/);
    await expectInvalid(sample.subarray(0, Math.floor(sample.length / 2)), /corrupt|unreadable/);
    await expectInvalid(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 500 }, (_, i) => (i * 37) % 256))]), /unreadable|corrupt/);
  });

  it('шифрлэгдсэн PDF (/Encrypt) → InvalidPdfError("encrypted")', async () => {
    const encrypted = await PDFDocument.load(sample);
    encrypted.context.trailerInfo.Encrypt = encrypted.context.register(
      encrypted.context.obj({ Filter: 'Standard', V: 1, R: 2, O: '12345678901234567890123456789012', U: '12345678901234567890123456789012', P: -4 }),
    );
    await expectInvalid(Buffer.from(await encrypted.save()), /encrypted/);
  });

  it('хуудасгүй PDF, MediaBox-гүй/буруу MediaBox, буруу /Contents, буруу /Resources → InvalidPdfError', async () => {
    const empty = await PDFDocument.create();
    await expectInvalid(Buffer.from(await empty.save({ addDefaultPage: false })), /no pages/);

    const broken = async (mutate: (page: ReturnType<PDFDocument['getPage']>) => void): Promise<Buffer> => {
      const doc = await PDFDocument.load(sample);
      mutate(doc.getPage(1));
      return Buffer.from(await doc.save());
    };
    await expectInvalid(await broken((p) => p.node.delete(PDFName.of('MediaBox'))), /unreadable/);
    await expectInvalid(await broken((p) => p.node.set(PDFName.of('MediaBox'), PDFNumber.of(5))), /unreadable/);
    await expectInvalid(await broken((p) => p.setMediaBox(0, 0, 0, 0)), /unreadable/);
    await expectInvalid(await broken((p) => p.node.set(PDFName.of('Contents'), PDFNumber.of(5))), /unreadable/);
    await expectInvalid(await broken((p) => p.node.set(PDFName.of('Resources'), PDFNumber.of(5))), /unreadable/);
  });

  it('StampInput-ийн програмын алдаа (TypeError, InvalidPdfError биш): буруу огноо, хоосон CMS, вэб биш verifyUrl, хоосон талбар', async () => {
    const cases: Array<[string, Parameters<typeof sampleStampInput>[1]]> = [
      ['signedAt', { signedAt: new Date(Number.NaN) }],
      ['certificate.notAfter', { certificate: { ...sampleStampInput(sample).certificate, notAfter: new Date(Number.NaN) } }],
      ['signatureCms', { signatureCms: Buffer.alloc(0) }],
      ['verifyUrl', { verifyUrl: 'javascript:alert(1)' }],
      ['verifyUrl', { verifyUrl: 'not a url' }],
      ['verifyUrl', { verifyUrl: 'ftp://example.com/verify/ABC' }],
      ['contractNo', { contractNo: ' \n ' }],
      ['verificationCode', { verificationCode: '' }],
    ];
    for (const [field, override] of cases) {
      const error = await stamper.stamp(sampleStampInput(sample, override)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(InvalidPdfError);
      expect((error as TypeError).message).toBe(`invalid stamp input: ${field}`);
    }
  });
});

// ---- Жинхэнэ PDF уншигчаар (poppler) — суулгаагүй орчинд алгасна ----
const hasPoppler = ['pdfinfo', 'pdftotext', 'pdftoppm', 'pdfdetach'].every((tool) => spawnSync(tool, ['-v']).error === undefined);

describe.skipIf(!hasPoppler)('PdfLibStamper: poppler-ээр баталгаажуулалт', () => {
  let dir: string;
  let renders = 0;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pdf-stamper-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, bytes: Buffer): string => {
    const file = join(dir, name);
    writeFileSync(file, bytes);
    return file;
  };

  /** pdftoppm → PPM (P6) → { width, height, at(x, y) → улаан суваг } */
  function render(file: string, page: number, dpi: number): { width: number; height: number; at: (x: number, y: number) => number } {
    const root = join(dir, `render-${renders++}`);
    execFileSync('pdftoppm', ['-r', String(dpi), '-f', String(page), '-l', String(page), '-singlefile', file, root]);
    const ppm = readFileSync(`${root}.ppm`);
    const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(ppm.subarray(0, 40).toString('latin1'))!;
    const [width, height] = [Number(header[1]), Number(header[2])];
    const data = ppm.subarray(ppm.length - width * height * 3);
    return { width, height, at: (x, y) => data[(y * width + x) * 3] };
  }
  /** Харагдах хуудасны баруун доод 18 мм QR-ийн талбар дахь харанхуй пикселийн хувь */
  function qrRegionDarkRatio(image: ReturnType<typeof render>, dpi: number): number {
    const px = (mmValue: number): number => Math.round((mm(mmValue) * dpi) / 72);
    const [x1, x0] = [image.width - px(8), image.width - px(8) - px(18)];
    const [y1, y0] = [image.height - px(8), image.height - px(8) - px(18)];
    let dark = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (image.at(x, y) < 110) dark++;
    return dark / ((x1 - x0) * (y1 - y0));
  }

  it('pdfinfo: хуудасны тоо + гарчиг, pdftotext: кирилл (Ө Ү) текст, pdfdetach: signature.p7s', async () => {
    const source = await createSamplePdf({ pages: 3 });
    const file = write('stamped.pdf', await stamper.stamp(sampleStampInput(source, { signerName: SIGNER, mock: false })));
    const info = execFileSync('pdfinfo', [file], { encoding: 'utf8' });
    expect(info).toMatch(/Pages:\s+4\b/);
    expect(info).toContain('Title:           ГЭР-2026-000123 — гарын үсэгтэй');
    expect(info).toContain('Producer:        LOS Radix DMS');

    const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    for (const expected of ['ЦАХИМ ГАРЫН ҮСГИЙН ХУУДАС', SIGNER, CAPTION, 'УА****5678', VERIFY_URL, 'Баталгаажуулах код', 'ЗЭЭЛИЙН ГЭРЭЭ № ГЭР-2026-000123']) {
      expect(text).toContain(expected);
    }
    expect(text).not.toContain('ХҮЧИНГҮЙ');

    const attachments = execFileSync('pdfdetach', ['-list', file], { encoding: 'utf8' });
    expect(attachments).toMatch(/1 embedded files\s+1: signature\.p7s/);
    const extracted = join(dir, 'extracted.p7s');
    execFileSync('pdfdetach', ['-save', '1', '-o', extracted, file]);
    expect(readFileSync(extracted).equals(CMS_BYTES)).toBe(true);
  });

  it('mock: pdftotext-д ус тэмдгийн үсгүүд гарна', async () => {
    const source = await createSamplePdf({ pages: 1 });
    const file = write('mock.pdf', await stamper.stamp(sampleStampInput(source, { mock: true })));
    const text = execFileSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8' });
    for (const letter of 'ТЕСХҮЧИНГЙ') expect(text).toContain(letter);
    expect(text).toContain('АНХААРУУЛГА: ТЕСТ ГАРЫН ҮСЭГ');
  });

  it.each([0, 90, 180, 270] as const)('/Rotate=%s°: жинхэнэ renderer-ээр харагдах хуудасны баруун доод буланд QR (хар цагаан ~45%) харагдана', async (rotation) => {
    const source = await createSamplePdf({ pages: 1, rotation });
    const after = write(`out-${rotation}.pdf`, await stamper.stamp(sampleStampInput(source, { mock: false })));
    const ratio = qrRegionDarkRatio(render(after, 1, 100), 100);
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(0.7);
    // Эргэлтгүй эх хуудасны баруун доод буланд юу ч байхгүй байсан — QR-ийг штамп нэмсэн
    if (rotation === 0) expect(qrRegionDarkRatio(render(write('src-0.pdf', source), 1, 100), 100)).toBeLessThan(0.01);
  });
});
