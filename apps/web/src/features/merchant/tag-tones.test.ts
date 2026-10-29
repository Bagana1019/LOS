import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MerchantStatus, PosLeaseStatus, PosReasonSeverity } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { MERCHANT_STATUS_COLOR, STATUS_COLOR } from './status';
import { contrastRatio, MIN_TEXT_CONTRAST, TAG_TONES, type TagTone } from './tag-tones';

// n=20: Tag-ийн текст WCAG AA (4.5:1) — antd-ийн preset (-7 сүүдэр) gold 2.76, green 3.37, cyan 3.39, orange 3.34, volcano 4.37 байсан.

describe('contrastRatio (WCAG 2.x)', () => {
  it('matches the reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 1); // AA-ийн хязгаарын сонгодог жишээ
  });
  it('detects the old antd preset pairs as failing (the check has teeth)', () => {
    const preset: Array<[string, string, string]> = [
      ['gold', '#d48806', '#fffbe6'], ['green', '#389e0d', '#f6ffed'], ['cyan', '#08979c', '#e6fffb'], ['orange', '#d46b08', '#fff7e6'], ['volcano', '#d4380d', '#fff2e8'],
    ];
    for (const [name, fg, bg] of preset) expect(contrastRatio(fg, bg), name).toBeLessThan(MIN_TEXT_CONTRAST);
  });
  it('rejects non #rrggbb input instead of returning a wrong number', () => {
    expect(() => contrastRatio('#fff', '#000000')).toThrow();
  });
});

describe('every Tag tone meets WCAG AA text contrast', () => {
  const tones = Object.keys(TAG_TONES) as TagTone[];
  it.each(tones)('%s: text on its own background >= 4.5:1', (tone) => {
    const { fg, bg } = TAG_TONES[tone];
    expect(contrastRatio(fg, bg), `${tone}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });
});

describe('status -> tone mapping', () => {
  it('every lease status, merchant status and reason severity resolves to a defined tone', () => {
    for (const s of PosLeaseStatus) expect(TAG_TONES[STATUS_COLOR[s]], s).toBeDefined();
    for (const s of MerchantStatus) expect(TAG_TONES[MERCHANT_STATUS_COLOR[s]], s).toBeDefined();
    // AdminLeaseDrawer-ийн шалтгааны ноцтой байдал: DECLINE red · REFER gold · INFO blue
    for (const tone of ['red', 'gold', 'blue'] as const) expect(TAG_TONES[tone]).toBeDefined();
    expect(PosReasonSeverity).toHaveLength(3);
  });
});

// Regression guard: antd preset `color="..."` (AA-аас доогуур) Tag-ийг эх кодод буцаж оруулахгүй. Бүх Tag `ToneTag`/`StatusTag`-аар дамжина.
describe('no raw antd <Tag color=...> in the merchant UI', () => {
  const ROOT = join(__dirname, '..', '..');
  const SCAN = ['features/merchant', 'app/merchant', 'app/settings/merchants', 'app/los/pos-leases'];
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx$/.test(name)) out.push(p);
    }
    return out;
  };
  it('uses ToneTag instead', () => {
    const offenders = SCAN.flatMap((d) => walk(join(ROOT, d))).filter((f) => /<Tag\b[^>]*\bcolor=/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
