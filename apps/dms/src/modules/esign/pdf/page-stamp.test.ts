import type { PDFFont } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { mm } from './format';
import { CAPTION_LABEL, planPageStamp, planWatermark, WATERMARK_TEXT, type PageStampPlan } from './page-stamp';
import { loadMeasureFonts } from './pdf-inspect';

const CAPTION = `${CAPTION_LABEL} · ГЭР-2026-000123 · 7K3Q-XM9Z-B4TN`;
const SIZES: Array<[string, number, number]> = [
  ['A4', 595.28, 841.89],
  ['A4 landscape', 841.89, 595.28],
  ['A5', 419.53, 595.28],
  ['A3', 841.89, 1190.55],
  ['A0', 2383.94, 3370.39],
  ['300×300', 300, 300],
  ['120×160', 120, 160],
  ['50×50', 50, 50],
  ['20×20', 20, 20],
  ['200×1500', 200, 1500],
  ['1500×200', 1500, 200],
];

let fonts: { regular: PDFFont; bold: PDFFont };
beforeAll(async () => {
  fonts = await loadMeasureFonts();
});

function expectInside(plan: PageStampPlan, width: number, height: number): void {
  const { qr } = plan;
  expect(qr.x).toBeGreaterThanOrEqual(0);
  expect(qr.y).toBeGreaterThanOrEqual(0);
  expect(qr.x + qr.size).toBeLessThanOrEqual(width + 1e-9);
  expect(qr.y + qr.size).toBeLessThanOrEqual(height + 1e-9);
  for (const line of plan.caption?.lines ?? []) {
    const lineWidth = fonts.regular.widthOfTextAtSize(line.text, plan.caption!.size);
    expect(line.x).toBeGreaterThanOrEqual(-1e-9);
    // Тайлбар QR-тай давхцахгүй, хуудсаас гарахгүй
    expect(line.x + lineWidth).toBeLessThanOrEqual(qr.x + 1e-9);
    expect(line.y).toBeGreaterThanOrEqual(0);
    expect(line.y + plan.caption!.size).toBeLessThanOrEqual(height + 1e-9);
  }
}

describe('planPageStamp', () => {
  it('A4: QR ≈ 18 мм (баруун доод, захаас 8 мм); тайлбар нэг мөр 7pt, QR-ийн зүүн талд босоо төвд', () => {
    const plan = planPageStamp(595.28, 841.89, CAPTION, fonts, false);
    expect(plan.qr.size).toBeCloseTo(mm(18), 6);
    expect(plan.qr.x + plan.qr.size).toBeCloseTo(595.28 - mm(8), 6);
    expect(plan.qr.y).toBeCloseTo(mm(8), 6);
    expect(plan.caption?.lines).toHaveLength(1);
    expect(plan.caption?.size).toBe(7);
    expect(plan.caption!.lines[0].text).toBe(CAPTION);
    const textRight = plan.caption!.lines[0].x + fonts.regular.widthOfTextAtSize(CAPTION, 7);
    expect(textRight).toBeLessThan(plan.qr.x);
    expect(textRight).toBeGreaterThan(plan.qr.x - 8);
    // Мөрийн босоо байрлал QR-ийн төвтэй ойролцоо
    expect(Math.abs(plan.caption!.lines[0].y - (plan.qr.y + plan.qr.size / 2))).toBeLessThan(7);
    expectInside(plan, 595.28, 841.89);
  });

  it.each(SIZES)('%s: QR/тайлбар хуудсанд багтаж, хоорондоо давхцахгүй', (_name, width, height) => {
    const plan = planPageStamp(width, height, CAPTION, fonts, true);
    expectInside(plan, width, height);
    expect(plan.qr.size).toBeLessThanOrEqual(Math.min(width, height) * 0.4 + 1e-9);
    if (width >= 595 && height >= 595) expect(plan.qr.size).toBeCloseTo(mm(18), 6);
  });

  it('жижиг хуудсанд штампыг харьцаагаар багасгана, A5-аас том хуудсанд тогтмол физик хэмжээ', () => {
    const a5 = planPageStamp(419.53, 595.28, CAPTION, fonts, false);
    const a0 = planPageStamp(2383.94, 3370.39, CAPTION, fonts, false);
    expect(a5.qr.size).toBeCloseTo(mm(18), 6);
    expect(a0.qr.size).toBeCloseTo(mm(18), 6);
    expect(planPageStamp(180, 240, CAPTION, fonts, false).qr.size).toBeLessThan(mm(18));
  });

  it('урт гэрээний дугаар: тайлбар багасаж/мөрлөгдөж, 3 мөрөөс хэтрэхгүй, хуудсаас гарахгүй', () => {
    const long = `${CAPTION_LABEL} · ${'ГЭР-ӨӨ-'.repeat(25)} · 7K3Q-XM9Z-B4TN`;
    for (const [width, height] of [[595.28, 841.89], [300, 300], [200, 1500]] as const) {
      const plan = planPageStamp(width, height, long, fonts, false);
      expect(plan.caption!.lines.length).toBeLessThanOrEqual(3);
      expect(plan.caption!.size).toBeLessThan(7);
      expectInside(plan, width, height);
    }
    const huge = `${CAPTION_LABEL} · ${'Х'.repeat(600)} · 7K3Q-XM9Z-B4TN`;
    const plan = planPageStamp(595.28, 841.89, huge, fonts, false);
    expect(plan.caption!.lines).toHaveLength(3);
    expect(plan.caption!.lines[2].text.endsWith('…')).toBe(true);
    expectInside(plan, 595.28, 841.89);
  });

  it('тайлбарт зай үлдээгүй маш явцуу хуудсанд тайлбарыг орхиж, QR-ийг л зурна', () => {
    const plan = planPageStamp(30, 400, CAPTION, fonts, false);
    expect(plan.caption).toBeNull();
    expectInside(plan, 30, 400);
  });

  it('mock үед л ус тэмдэг төлөвлөнө', () => {
    expect(planPageStamp(595.28, 841.89, CAPTION, fonts, false).watermark).toBeNull();
    expect(planPageStamp(595.28, 841.89, CAPTION, fonts, true).watermark?.text).toBe('ТЕСТ — ХҮЧИНГҮЙ');
    expect(WATERMARK_TEXT).toBe('ТЕСТ — ХҮЧИНГҮЙ');
  });
});

describe('planWatermark', () => {
  it.each(SIZES.filter(([name]) => name !== '20×20' && name !== '50×50'))('%s: эргэсэн текстийн bounding box хуудсанд багтаж, төвд байрлана', (_name, width, height) => {
    const wm = planWatermark(width, height, fonts.bold);
    const length = fonts.bold.widthOfTextAtSize(wm.text, wm.size);
    const cap = wm.size * 0.73;
    const rad = (wm.angle * Math.PI) / 180;
    const [ux, uy] = [Math.cos(rad), Math.sin(rad)];
    // Текстийн 4 орой: baseline эхлэл + (0|урт)·u + (0|cap)·n
    const corners = [0, length].flatMap((along) => [0, cap].map((up) => [wm.x + along * ux - up * uy, wm.y + along * uy + up * ux]));
    for (const [x, y] of corners) {
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(width + 1e-6);
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(y).toBeLessThanOrEqual(height + 1e-6);
    }
    const centre = [corners.reduce((sum, c) => sum + c[0], 0) / 4, corners.reduce((sum, c) => sum + c[1], 0) / 4];
    expect(centre[0]).toBeCloseTo(width / 2, 6);
    expect(centre[1]).toBeCloseTo(height / 2, 6);
    expect(wm.size).toBeLessThanOrEqual(96);
  });

  it('A4 босоо хуудсанд булан-булан диагональ чиглэлтэй (~55°), том хэмжээтэй', () => {
    const wm = planWatermark(595.28, 841.89, fonts.bold);
    expect(wm.angle).toBeCloseTo((Math.atan2(841.89, 595.28) * 180) / Math.PI, 6);
    expect(wm.size).toBeGreaterThan(60);
  });
});
