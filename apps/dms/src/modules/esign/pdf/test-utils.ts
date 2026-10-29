// FR-11.4 Тестэд зориулсан жишээ гэрээний PDF үүсгэгч (production-д ашиглагдахгүй). Кирилл (Ө ө Ү ү) тексттэй, олон хуудастай,
// deterministic (тогтмол огноо, санамсаргүй зүйлгүй) тул ижил оролтод ижил bytes гарна.
import fontkit from '@pdf-lib/fontkit';
import { degrees, grayscale, PDFDocument } from 'pdf-lib';
import { loadFontBytes } from './fonts';
import { mm } from './format';
import { sanitizeText, wrapText } from './text-layout';

/** A4, pt (595.28 × 841.89) */
export const A4_SIZE: readonly [number, number] = [595.28, 841.89];
export const SAMPLE_CONTRACT_NO = 'ГЭР-2026-000123';

const PAGE_PRESETS = {
  A3: [841.89, 1190.55],
  A4: A4_SIZE,
  A5: [419.53, 595.28],
  LETTER: [612, 792],
} as const satisfies Record<string, readonly [number, number]>;

export type SamplePageSize = readonly [number, number] | { width: number; height: number } | keyof typeof PAGE_PRESETS;

export interface SamplePdfOptions {
  /** Хуудасны тоо (анхдагч 3) */
  pages?: number;
  /** Хуудасны хэмжээ pt-ээр: `[өргөн, өндөр]`, `{ width, height }` эсвэл 'A3' | 'A4' | 'A5' | 'LETTER' (анхдагч A4) */
  size?: SamplePageSize;
  /** Бүх хуудсанд /Rotate утга (анхдагч 0) */
  rotation?: 0 | 90 | 180 | 270;
}

function resolveSize(size: SamplePageSize): readonly [number, number] {
  let dimensions: readonly [number, number];
  if (typeof size === 'string') dimensions = PAGE_PRESETS[size];
  else if ('width' in size) dimensions = [size.width, size.height];
  else dimensions = size;
  const [width, height] = dimensions;
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new RangeError('size must be positive finite numbers');
  return dimensions;
}

const CLAUSES = [
  'Зээлдүүлэгч (цаашид "ББСБ" гэх) болон зээлдэгч нар Монгол Улсын Иргэний хууль, Банк бус санхүүгийн үйл ажиллагааны тухай хуулийн дагуу доорх нөхцөлөөр зээлийн гэрээг байгуулав.',
  'Зээлдүүлэгч нь зээлдэгчид зээлийн үндсэн төлбөрийг гэрээнд заасан хугацаанд олгож, зээлдэгч нь зээлийн үндсэн төлбөр, хүүг төлбөрийн хуваарийн дагуу эргэн төлөх үүргийг хүлээнэ.',
  'Зээлийн хүү нь жилийн хувиар тооцогдож, төлбөрийн хуваарьт заасан өдрүүдэд төлөгдөнө. Төлбөрийн хугацаа хэтэрсэн тохиолдолд хоног тутам алдангийг тооцно.',
  'Зээлийн барьцаа хөрөнгө нь гэрээнд хавсаргасан барьцааны гэрээгээр баталгаажна. Өмчлөгч нь хөрөнгийн бүрэн бүтэн байдлыг хариуцаж, өөрийн зөвшөөрөлгүйгээр худалдах, шилжүүлэхгүй.',
  'Талууд өөрсдийн хүсэл зоригоор, аливаа албадлагагүйгээр энэхүү гэрээг байгуулсан бөгөөд гэрээний нөхцөлтэй бүрэн танилцаж, ойлгосноо баталгаажуулав.',
  'Гэрээнээс үүссэн маргааныг талууд эвийн журмаар шийдвэрлэх бөгөөд тохиролцоонд хүрээгүй тохиолдолд эрх бүхий шүүхээр шийдвэрлүүлнэ.',
  'Талууд гэрээний нөхцөл, зээлдэгчийн хувийн мэдээллийг гуравдагч этгээдэд задруулахгүй байх үүрэгтэй. Үүргийн зөрчил нь хохирлыг нөхөн төлөх үндэслэл болно.',
  'Гэрээг цахим гарын үсгээр баталгаажуулсан тохиолдолд цаасан хэлбэрээр байгуулсантай адил хуулийн хүчинтэй байна.',
];

const SAMPLE_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
const BODY_SIZE = 10.5;
const LINE_HEIGHT = 15;
/** Заалтын дугаарын hanging indent, pt */
const NUMBER_INDENT = 22;

/** Жишээ гэрээний PDF: 1-р хуудсанд гарчиг, хуудас бүрт зүйл заалтууд ба төвд нь "Хуудас i / n" хөл. Баруун доод булан хоосон. */
export async function createSamplePdf(options: SamplePdfOptions = {}): Promise<Buffer> {
  const { pages = 3, size = A4_SIZE, rotation = 0 } = options;
  if (!Number.isInteger(pages) || pages < 1) throw new RangeError('pages must be a positive integer');
  const [width, height] = resolveSize(size);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(await loadFontBytes('regular'), { subset: true });
  const bold = await doc.embedFont(await loadFontBytes('bold'), { subset: true });
  doc.setTitle(`Зээлийн гэрээ ${SAMPLE_CONTRACT_NO}`);
  doc.setAuthor('LOS Radix DMS test');
  doc.setCreator('createSamplePdf');
  doc.setProducer('createSamplePdf');
  doc.setCreationDate(SAMPLE_DATE);
  doc.setModificationDate(SAMPLE_DATE);

  const margin = Math.min(mm(20), width * 0.12);
  const textWidth = width - 2 * margin;
  // Заалт бүрийн мөрлөлтийг нэг удаа тооцно (олон хуудастай PDF-д хэмжилт удаашрахаас сэргийлнэ)
  const wrapped = CLAUSES.map((clause) => wrapText(sanitizeText(clause), regular, BODY_SIZE, textWidth - NUMBER_INDENT));
  let clause = 0;
  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage([width, height]);
    if (rotation !== 0) page.setRotation(degrees(rotation));
    let y = height - margin;
    if (n === 1) {
      for (const line of wrapText(`ЗЭЭЛИЙН ГЭРЭЭ № ${SAMPLE_CONTRACT_NO}`, bold, 15, textWidth)) {
        y -= 21;
        page.drawText(line, { x: margin, y, size: 15, font: bold });
      }
      y -= 10;
    }
    // Хөл (хуудасны дугаар) болон баруун доод буланг хоосон үлдээнэ
    for (;;) {
      const lines = wrapped[clause % wrapped.length];
      if (y - lines.length * LINE_HEIGHT < margin + 40) break;
      page.drawText(`${clause + 1}.`, { x: margin, y: y - LINE_HEIGHT, size: BODY_SIZE, font: regular });
      for (const line of lines) {
        y -= LINE_HEIGHT;
        page.drawText(line, { x: margin + NUMBER_INDENT, y, size: BODY_SIZE, font: regular });
      }
      y -= 9;
      clause++;
    }
    const footer = `Хуудас ${n} / ${pages}`;
    page.drawText(footer, { x: (width - regular.widthOfTextAtSize(footer, 8)) / 2, y: margin / 2, size: 8, font: regular, color: grayscale(0.4) });
  }
  return Buffer.from(await doc.save());
}
