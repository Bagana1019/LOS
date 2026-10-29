// Төлөв/ангиллын Tag-ийн өнгө (цэвэр өгөгдөл). antd-ийн preset Tag (`color="gold"`) нь -7 сүүдэртэй текстийг -1 дэвсгэр дээр зурдаг бөгөөд
// 12px текстэд WCAG AA (4.5:1)-ээс доогуур (gold 2.76, green 3.37, cyan 3.39, orange 3.34, volcano 4.37). Тиймээс -8/-9 сүүдрийг шууд заана.
// Утга бүр tag-tones.test.ts-д 4.5:1-ээр шалгагдана. Өнгө дангаараа биш — Tag үргэлж текстэй.

export type TagTone = 'default' | 'gold' | 'green' | 'cyan' | 'orange' | 'volcano' | 'red' | 'blue' | 'purple';
export interface TagPalette { fg: string; bg: string; border: string }

export const TAG_TONES: Record<TagTone, TagPalette> = {
  default: { fg: '#3b4657', bg: '#f0f2f6', border: '#cfd7e3' },
  gold: { fg: '#874d00', bg: '#fffbe6', border: '#ffe58f' },
  green: { fg: '#237804', bg: '#f6ffed', border: '#b7eb8f' },
  cyan: { fg: '#006d75', bg: '#e6fffb', border: '#87e8de' },
  orange: { fg: '#ad4e00', bg: '#fff7e6', border: '#ffd591' },
  volcano: { fg: '#ad2102', bg: '#fff2e8', border: '#ffbb96' },
  red: { fg: '#a8071a', bg: '#fff1f0', border: '#ffa39e' },
  blue: { fg: '#003eb3', bg: '#e6f4ff', border: '#91caff' },
  purple: { fg: '#391085', bg: '#f9f0ff', border: '#d3adf7' },
};

/** WCAG 2.x AA: энгийн (<18.66px bold / <24px) текстийн хамгийн бага контраст. */
export const MIN_TEXT_CONTRAST = 4.5;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`expected #rrggbb, got ${hex}`);
  const n = parseInt(m[1]!, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
/** WCAG харьцаа (1–21) хоёр #rrggbb өнгөний хооронд. */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
