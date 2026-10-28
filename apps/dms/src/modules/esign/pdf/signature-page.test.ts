import type { PDFFont } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { mm } from './format';
import { loadMeasureFonts } from './pdf-inspect';
import {
  buildSignatureContent,
  layoutSignaturePage,
  MIN_SIGNATURE_PAGE_HEIGHT_PT,
  MIN_SIGNATURE_PAGE_WIDTH_PT,
  SIGNATURE_PAGE_TITLE,
  signaturePageSize,
  type LayoutOp,
  type SignaturePageLayout,
} from './signature-page';
import { GROUPED_CODE, sampleStampInput, VERIFY_URL } from './test-fixtures';

let fonts: { regular: PDFFont; bold: PDFFont };
beforeAll(async () => {
  fonts = await loadMeasureFonts();
});

const pdf = Buffer.from('%PDF-1.7 sample');
const texts = (layout: SignaturePageLayout) => layout.ops.filter((op): op is Extract<LayoutOp, { kind: 'text' }> => op.kind === 'text');

function expectFits(layout: SignaturePageLayout): void {
  const { width, height, column } = layout;
  for (const op of layout.ops) {
    if (op.kind === 'text') {
      expect(op.x).toBeGreaterThanOrEqual(column.left - 1e-6);
      expect(op.x + op.width).toBeLessThanOrEqual(column.right + 1e-6);
      expect(op.y).toBeGreaterThan(0);
      expect(op.y + op.size).toBeLessThanOrEqual(height);
    } else if (op.kind === 'rule') {
      expect(op.x1).toBeGreaterThanOrEqual(0);
      expect(op.x2).toBeLessThanOrEqual(width);
      expect(op.y).toBeGreaterThan(0);
      expect(op.y).toBeLessThan(height);
    } else {
      expect(op.x).toBeGreaterThanOrEqual(column.left - 1e-6);
      expect(op.x + op.size).toBeLessThanOrEqual(column.right + 1e-6);
      expect(op.y).toBeGreaterThan(0);
      expect(op.y + op.size).toBeLessThanOrEqual(height);
    }
  }
}

describe('buildSignatureContent', () => {
  const content = buildSignatureContent(sampleStampInput(pdf));

  it('брифийн дарааллаар мөрүүдийг гаргана', () => {
    expect(content.rows.map((row) => row.label)).toEqual([
      'Гэрээний дугаар',
      'Гарын үсэг зурсан',
      'Регистр',
      'Үйлчилгээ үзүүлэгч',
      'Гэрчилгээ олгогч',
      'Гэрчилгээний сериал',
      'Гэрчилгээ хүчинтэй хугацаа',
      'Гарын үсэг зурсан огноо',
      'Баримтын SHA-256 (эх хувь)',
      'Баталгаажуулах код',
      'Баталгаажуулах хаяг',
    ]);
  });

  it('утгууд: нэр, далдалсан регистр, provider, гэрчилгээ, огноо (UTC+8 + UTC ISO), хоёр мөр SHA-256, бүлэглэсэн код, URL', () => {
    const input = sampleStampInput(pdf);
    const byLabel = new Map(content.rows.map((row) => [row.label, row.lines]));
    expect(byLabel.get('Гэрээний дугаар')).toEqual(['ГЭР-2026-000123']);
    expect(byLabel.get('Гарын үсэг зурсан')).toEqual(['Бат-Эрдэнэ Болд']);
    expect(byLabel.get('Регистр')).toEqual(['УА****5678']);
    expect(byLabel.get('Үйлчилгээ үзүүлэгч')).toEqual(['Tridum']);
    expect(byLabel.get('Гэрчилгээ олгогч')).toEqual(['LOS MOCK CA (ТЕСТ)']);
    expect(byLabel.get('Гэрчилгээний сериал')).toEqual(['4A:3F:00:9C:11:7E:22:B5']);
    expect(byLabel.get('Гэрчилгээ хүчинтэй хугацаа')).toEqual(['2026-01-01 08:00:00 – 2028-01-01 08:00:00 (UTC+8)']);
    expect(byLabel.get('Гарын үсэг зурсан огноо')).toEqual(['2026-10-28 11:15:42 (UTC+8)', '2026-10-28T03:15:42.000Z (UTC)']);
    const sha = byLabel.get('Баримтын SHA-256 (эх хувь)')!;
    expect(sha).toHaveLength(2);
    expect(sha[0]).toHaveLength(32);
    expect(sha.join('')).toBe(input.originalSha256);
    expect(byLabel.get('Баталгаажуулах код')).toEqual([GROUPED_CODE]);
    expect(byLabel.get('Баталгаажуулах хаяг')).toEqual([VERIFY_URL]);
  });

  it('нэр/CN дахь bidi override, мөр таслагч, хэт урт утгыг цэвэрлэнэ', () => {
    const hostile = buildSignatureContent(
      sampleStampInput(pdf, {
        signerName: '‮нохой‬\nБолд',
        certificate: { ...sampleStampInput(pdf).certificate, issuer: 'CA '.repeat(5000) },
      }),
    );
    const byLabel = new Map(hostile.rows.map((row) => [row.label, row.lines]));
    expect(byLabel.get('Гарын үсэг зурсан')).toEqual(['нохой Болд']);
    expect(Array.from(byLabel.get('Гэрчилгээ олгогч')![0]).length).toBeLessThanOrEqual(256);
  });
});

describe('signaturePageSize', () => {
  it('эхний хуудасны хэмжээг хадгалж, доод хязгаараас (300 × 420 pt) жижиг талыг томруулна', () => {
    expect(signaturePageSize(595.28, 841.89)).toEqual({ width: 595.28, height: 841.89 });
    expect(signaturePageSize(841.89, 595.28)).toEqual({ width: 841.89, height: 595.28 });
    expect(signaturePageSize(120, 160)).toEqual({ width: MIN_SIGNATURE_PAGE_WIDTH_PT, height: MIN_SIGNATURE_PAGE_HEIGHT_PT });
    expect(signaturePageSize(200, 1500)).toEqual({ width: 300, height: 1500 });
    expect(signaturePageSize(1500, 100)).toEqual({ width: 1500, height: 420 });
  });
});

describe('layoutSignaturePage', () => {
  const content = buildSignatureContent(sampleStampInput(pdf));

  it('A4: бүтэн масштаб, QR = 40 мм, гарчиг ба бүх мөр хуудсанд багтана', () => {
    const layout = layoutSignaturePage(content, fonts, 595.28, 841.89);
    expect(layout.scale).toBe(1);
    const qrs = layout.ops.filter((op) => op.kind === 'qr');
    expect(qrs).toHaveLength(1);
    expect(qrs[0]).toMatchObject({ size: expect.closeTo(mm(40), 6) });
    expect(texts(layout)[0].text).toBe(SIGNATURE_PAGE_TITLE);
    expectFits(layout);
  });

  const hostile = (): ReturnType<typeof buildSignatureContent> =>
    buildSignatureContent(
      sampleStampInput(pdf, {
        contractNo: 'ГЭР-ӨӨ-'.repeat(40),
        signerName: 'Өлзийбат-Эрдэнэ Үүрцайхгийн Төмөр-Очирын Бат-Өлзий '.repeat(6),
        providerDisplayName: 'Monpass '.repeat(30),
        verifyUrl: `https://sign.example.mn/verify/${'7K3QXM9ZB4TN'.repeat(30)}?utm=${'x'.repeat(100)}`,
        certificate: {
          ...sampleStampInput(pdf).certificate,
          issuer: 'Монголын Тэргүүлэх Гэрчилгээжүүлэх Байгууллага '.repeat(8),
          serialNumber: '4A3F009C117E22B5'.repeat(20),
        },
      }),
    );

  it.each([
    ['A4 landscape', 841.89, 595.28],
    ['A5', 419.53, 595.28],
    ['A3', 841.89, 1190.55],
    ['A0', 2383.94, 3370.39],
    ['300×300 (→ 300×420 доод хязгаар)', 300, 300],
    ['явцуу урт 300×1500', 300, 1500],
    ['өргөн намхан 1500×300', 1500, 300],
    ['A6 хэвтээ', 419.53, 297.64],
  ])('%s: энгийн агуулга бүрэн, таслагдахгүй багтана', (_name, width, height) => {
    const size = signaturePageSize(width, height);
    const layout = layoutSignaturePage(content, fonts, size.width, size.height);
    expect(layout.scale).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(layout.scale).toBeLessThanOrEqual(1);
    expectFits(layout);
    expect(texts(layout).some((op) => op.text.includes('…'))).toBe(false);
  });

  it.each([
    ['A5', 419.53, 595.28],
    ['300×300 (→ 300×420 доод хязгаар)', 300, 300],
    ['өргөн намхан 1500×300', 1500, 300],
    ['A6 хэвтээ', 419.53, 297.64],
  ])('%s: хэт урт (256 тэмдэгтийн) утгууд ч халилтгүй — … -ээр таслагдаж, масштаб ≥ 0.3', (_name, width, height) => {
    const size = signaturePageSize(width, height);
    const layout = layoutSignaturePage(hostile(), fonts, size.width, size.height);
    expect(layout.scale).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expectFits(layout);
    expect(texts(layout).some((op) => op.text.endsWith('…'))).toBe(true);
  });

  it('жижиг хуудсанд масштаб буурна', () => {
    expect(layoutSignaturePage(content, fonts, 300, 300).scale).toBeLessThan(1);
  });

  it('явцуу хуудсанд QR-ийг тайлбарын доор байрлуулна (stack), өргөн хуудсанд хажууд нь баруун талд', () => {
    const wide = layoutSignaturePage(content, fonts, 595.28, 841.89);
    const wideQr = wide.ops.find((op) => op.kind === 'qr')!;
    expect(wideQr.x + (wideQr as { size: number }).size).toBeCloseTo(wide.column.right, 6);

    const narrow = layoutSignaturePage(content, fonts, 300, 842);
    const narrowQr = narrow.ops.find((op) => op.kind === 'qr') as { x: number; y: number; size: number };
    const hint = texts(narrow).find((op) => op.text.startsWith('Утасныхаа'))!;
    expect(narrowQr.y + narrowQr.size).toBeLessThan(hint.y); // QR тайлбараас доош
    expect(narrowQr.x + narrowQr.size / 2).toBeCloseTo((narrow.column.left + narrow.column.right) / 2, 6);
  });

  it('урт URL ба SHA-256 тэмдэгт алдагдалгүй мөрлөгдөнө', () => {
    const url = `https://sign.example.mn/verify/${'7K3QXM9ZB4TN'.repeat(5)}`;
    const input = sampleStampInput(pdf, { verifyUrl: url });
    const layout = layoutSignaturePage(buildSignatureContent(input), fonts, 300, 842);
    const all = texts(layout).map((op) => op.text).join('').replace(/\s/g, '');
    expect(all).toContain(url);
    expect(all).toContain(input.originalSha256.slice(0, 32));
    expect(all).toContain(input.originalSha256.slice(32));
  });

  it('mock үед л "ТЕСТ ГАРЫН ҮСЭГ" анхааруулга орно', () => {
    const mockLayout = layoutSignaturePage(buildSignatureContent(sampleStampInput(pdf, { mock: true })), fonts, 595.28, 841.89);
    const realLayout = layoutSignaturePage(buildSignatureContent(sampleStampInput(pdf, { mock: false })), fonts, 595.28, 841.89);
    expect(texts(mockLayout).some((op) => op.text.includes('ТЕСТ ГАРЫН ҮСЭГ'))).toBe(true);
    expect(texts(realLayout).some((op) => op.text.includes('ТЕСТ ГАРЫН ҮСЭГ'))).toBe(false);
  });

  it('мөр бүрийн утгууд босоо чиглэлд давхцахгүй (дараалсан мөр дээрээс доош)', () => {
    const layout = layoutSignaturePage(content, fonts, 595.28, 841.89);
    const valueColumn = texts(layout).filter((op) => op.x > layout.column.left + 100);
    const ys = valueColumn.map((op) => op.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThan(ys[i - 1] + 1e-6);
  });
});
