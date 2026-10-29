import { describe, expect, it } from 'vitest';
import { AgingBucket, ApplicationStatus, DashboardQuery, DashboardSummary } from '@los/contracts';
import mnBase from '../../../../../packages/ui/src/i18n/mn.json';
import mnReport from '../../../../../packages/ui/src/i18n/mn.report.json';
import {
  AGING_COLORS, CHART_COLORS, DEFAULT_DASHBOARD_FILTERS, agingRows, buildDashboardQuery, changeRatio, deltaTone, formatCompact, formatDelta, formatHours, formatRatio,
  isDashboardEmpty, isMonthlyEmpty, layoutMonthlyBars, monthAxisLabel, monthParts, niceScale, parseDashboardFilters, productRows, roundedTopBarPath, sameDashboardFilters,
  scopeText, statusRows, toDashboardSearchParams,
} from './dashboard.utils';
import type { Translate } from './reports.utils';

const dict = { ...(mnBase as Record<string, string>), ...(mnReport as Record<string, string>) };
const tr: Translate = (key, params) => {
  const raw = dict[key] ?? `!${key}`;
  return params ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`)) : raw;
};

// ── fixture: 12 сар, 2026-10 = сүүлийн сар ──────────────────────────────────────────
const MONTHS = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const summary = (over: Partial<DashboardSummary> = {}): DashboardSummary => ({
  asOf: '2026-10-28', currency: 'MNT', scope: { branchId: null, officerId: null },
  applications: {
    byStatus: [{ status: 'SUBMITTED', count: 4, amount: 40_000_000 }, { status: 'ACTIVE', count: 10, amount: 100_000_000 }],
    submittedThisMonth: 4, approvedThisMonth: 3, returnedThisMonth: 1, approvalRate: 0.75, avgDecisionHours: 26.5,
  },
  disbursements: {
    thisMonthAmount: 30_000_000, lastMonthAmount: 20_000_000, thisMonthCount: 3, yearToDateAmount: 90_000_000,
    monthly: MONTHS.map((month, i) => ({ month, amount: i === 11 ? 30_000_000 : i === 10 ? 20_000_000 : 0, count: i >= 10 ? 2 : 0 })),
  },
  portfolio: {
    activeLoanCount: 10, outstandingPrincipal: 80_000_000, overdueAmount: 5_000_000, overdueLoanCount: 2, parRatio: 0.0625,
    aging: [{ bucket: 'CURRENT', loanCount: 8, principal: 60_000_000 }, { bucket: 'DPD_31_60', loanCount: 2, principal: 20_000_000 }],
  },
  collections: { dueThisMonth: 10_000_000, collectedThisMonth: 7_500_000, collectionRate: 0.75, dueNext7Days: 2_000_000 },
  topProducts: [{ productId: 'p1', productName: 'Хэрэглээний зээл', count: 6, amount: 60_000_000 }, { productId: null, productName: 'Бусад', count: 2, amount: 15_000_000 }],
  generatedAt: '2026-10-28T09:00:00.000Z',
  ...over,
});
const emptySummary = (): DashboardSummary => summary({
  applications: { byStatus: ApplicationStatus.map((status) => ({ status, count: 0, amount: 0 })), submittedThisMonth: 0, approvedThisMonth: 0, returnedThisMonth: 0, approvalRate: null, avgDecisionHours: null },
  disbursements: { thisMonthAmount: 0, lastMonthAmount: 0, thisMonthCount: 0, yearToDateAmount: 0, monthly: MONTHS.map((month) => ({ month, amount: 0, count: 0 })) },
  portfolio: { activeLoanCount: 0, outstandingPrincipal: 0, overdueAmount: 0, overdueLoanCount: 0, parRatio: null, aging: AgingBucket.map((bucket) => ({ bucket, loanCount: 0, principal: 0 })) },
  collections: { dueThisMonth: 0, collectedThisMonth: 0, collectionRate: null, dueNext7Days: 0 },
  topProducts: [],
});

describe('fixtures нь DTO-той таарна', () => {
  it('DashboardSummary', () => {
    expect(DashboardSummary.safeParse(summary()).success).toBe(true);
    expect(DashboardSummary.safeParse(emptySummary()).success).toBe(true);
  });
});

// ── шүүлт ↔ URL ─────────────────────────────────────────────────────────────────────
describe('Dashboard шүүлт', () => {
  const sp = (q: string) => new URLSearchParams(q);
  it('анхдагч', () => {
    expect(parseDashboardFilters(sp(''))).toEqual(DEFAULT_DASHBOARD_FILTERS);
    expect(DEFAULT_DASHBOARD_FILTERS).toEqual({ asOf: null, currency: 'MNT', branchId: null });
  });
  it('зөв утгууд (валют том үсэг болно)', () => {
    expect(parseDashboardFilters(sp('asOf=2026-09-30&currency=usd&branchId=%20b1%20'))).toEqual({ asOf: '2026-09-30', currency: 'USD', branchId: 'b1' });
  });
  it('буруу огноо, дэмжигдэхгүй валютыг анхдагч руу', () => {
    expect(parseDashboardFilters(sp('asOf=2026-02-31&currency=EUR'))).toEqual({ asOf: null, currency: 'MNT', branchId: null });
    expect(parseDashboardFilters(sp('branchId=' + 'x'.repeat(150))).branchId).toHaveLength(100);
  });
  it('URL round-trip, анхдагчийг оруулахгүй', () => {
    expect(toDashboardSearchParams(DEFAULT_DASHBOARD_FILTERS).toString()).toBe('');
    const f = { asOf: '2026-09-30', currency: 'USD', branchId: 'b1' };
    expect(parseDashboardFilters(toDashboardSearchParams(f))).toEqual(f);
  });
  it('API query нь DashboardQuery-д таарна (backend гэрээ)', () => {
    expect(buildDashboardQuery(DEFAULT_DASHBOARD_FILTERS)).toEqual({ currency: 'MNT' });
    const q = buildDashboardQuery({ asOf: '2026-09-30', currency: 'USD', branchId: 'b1' });
    expect(q).toEqual({ currency: 'USD', asOf: '2026-09-30', branchId: 'b1' });
    expect(DashboardQuery.safeParse(q).success).toBe(true);
    expect(DashboardQuery.parse({}).currency).toBe('MNT');
  });
  it('sameDashboardFilters', () => {
    expect(sameDashboardFilters(DEFAULT_DASHBOARD_FILTERS, { asOf: null, currency: 'MNT', branchId: null })).toBe(true);
    expect(sameDashboardFilters(DEFAULT_DASHBOARD_FILTERS, { asOf: null, currency: 'USD', branchId: null })).toBe(false);
  });
});

// ── KPI текст ───────────────────────────────────────────────────────────────────────
describe('KPI форматлалт', () => {
  it('formatRatio: 1 орон, null → —', () => {
    expect(formatRatio(0.0625)).toBe('6.3%');
    expect(formatRatio(0.75)).toBe('75%');
    expect(formatRatio(0)).toBe('0%');
    expect(formatRatio(1)).toBe('100%');
    expect(formatRatio(null)).toBe('—');
    expect(formatRatio(undefined)).toBe('—');
  });
  it('formatHours', () => {
    expect(formatHours(26.5, tr)).toBe('26.5 цаг');
    expect(formatHours(0, tr)).toBe('0 цаг');
    expect(formatHours(null, tr)).toBe('—');
  });
  it('changeRatio: өмнөх үе 0 бол харьцуулахгүй', () => {
    expect(changeRatio(30, 20)).toBeCloseTo(0.5);
    expect(changeRatio(10, 20)).toBeCloseTo(-0.5);
    expect(changeRatio(10, 0)).toBeNull();
    expect(changeRatio(0, 0)).toBeNull();
    expect(changeRatio(0, 20)).toBe(-1);
  });
  it('deltaTone, formatDelta', () => {
    expect(deltaTone(0.5)).toBe('up');
    expect(deltaTone(-0.001)).toBe('down');
    expect(deltaTone(0.0001)).toBe('flat'); // 0.1%-иас бага
    expect(deltaTone(null)).toBeNull();
    expect(formatDelta(0.5)).toBe('+50%');
    expect(formatDelta(0.1234)).toBe('+12.3%');
    expect(formatDelta(-0.032)).toBe('-3.2%');
    expect(formatDelta(0)).toBe('0%');
    expect(formatDelta(-0.00001)).toBe('0%');
    expect(formatDelta(null)).toBe('—');
  });
  it('scopeText: ЗЭЗ > салбар > бүгд', () => {
    expect(scopeText({ branchId: null, officerId: null }, tr)).toBe('бүх салбар');
    expect(scopeText({ branchId: 'b1', officerId: null }, tr)).toBe('салбар b1');
    expect(scopeText({ branchId: null, officerId: 'u7' }, tr)).toBe('ЗЭЗ u7');
    expect(scopeText({ branchId: 'b1', officerId: 'u7' }, tr)).toBe('ЗЭЗ u7');
  });
  it('хоосон байдал', () => {
    expect(isDashboardEmpty(emptySummary())).toBe(true);
    expect(isDashboardEmpty(summary())).toBe(false);
    expect(isMonthlyEmpty(emptySummary().disbursements.monthly)).toBe(true);
    expect(isMonthlyEmpty(summary().disbursements.monthly)).toBe(false);
  });
});

// ── диаграмын масштаб, геометр ──────────────────────────────────────────────────────
describe('niceScale', () => {
  it('1/2/5 × 10^k алхам, 0-ээс эхэлж max-аас багагүй', () => {
    expect(niceScale(30_000_000)).toEqual({ max: 30_000_000, ticks: [0, 10_000_000, 20_000_000, 30_000_000] });
    expect(niceScale(35_000_000)).toEqual({ max: 40_000_000, ticks: [0, 10_000_000, 20_000_000, 30_000_000, 40_000_000] });
    expect(niceScale(100)).toEqual({ max: 100, ticks: [0, 50, 100] });
    expect(niceScale(7)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
  });
  it('янз бүрийн утгад max ≥ утга, tick-үүд өсөх дараалалтай, ≤ 6 tick', () => {
    for (const v of [1, 7, 99, 100, 101, 999, 1234, 56_789, 3_450_000, 1e9, 2.5e9]) {
      const s = niceScale(v);
      expect(s.max, String(v)).toBeGreaterThanOrEqual(v);
      expect(s.ticks[0]).toBe(0);
      expect(s.ticks.at(-1)).toBe(s.max);
      expect(s.ticks.length, String(v)).toBeLessThanOrEqual(7);
      expect(s.ticks.every((t, i) => i === 0 || t > s.ticks[i - 1])).toBe(true);
    }
  });
  it('тэг/буруу утга → [0, 1]', () => {
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(Number.NaN)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(-5)).toEqual({ max: 1, ticks: [0, 1] });
  });
});

describe('formatCompact', () => {
  it('мянга / сая / тэрбум', () => {
    expect(formatCompact(0, tr)).toBe('0');
    expect(formatCompact(500, tr)).toBe('500');
    expect(formatCompact(500_000, tr)).toBe('500 мянга');
    expect(formatCompact(1_500_000, tr)).toBe('1.5 сая');
    expect(formatCompact(30_000_000, tr)).toBe('30 сая');
    expect(formatCompact(2_000_000_000, tr)).toBe('2 тэрбум');
  });
});

describe('roundedTopBarPath', () => {
  it('дээд 2 булан дугуй, суурь тэгш (Z-ээр хаагдсан)', () => {
    const d = roundedTopBarPath(10, 20, 24, 100, 4);
    expect(d).toBe('M10,120 L10,24 Q10,20 14,20 L30,20 Q34,20 34,24 L34,120 Z');
  });
  it('намхан баганад радиус өндрөөс хэтрэхгүй', () => {
    expect(roundedTopBarPath(0, 98, 24, 2, 4)).toBe('M0,100 L0,100 Q0,98 2,98 L22,98 Q24,98 24,100 L24,100 Z');
  });
});

describe('layoutMonthlyBars', () => {
  const monthly = summary().disbursements.monthly;
  const plot = { width: 600, height: 200 };
  const bars = layoutMonthlyBars(monthly, plot, 40_000_000);
  it('12 бүс, нэгэн ижил өргөн, багана ≤ 24px, бүсийн төвд', () => {
    expect(bars).toHaveLength(12);
    for (const b of bars) {
      expect(b.width).toBeLessThanOrEqual(24);
      expect(b.bandWidth).toBe(50);
      expect(b.x + b.width / 2).toBeCloseTo(b.bandX + b.bandWidth / 2, 1);
      expect(b.cx).toBeCloseTo(b.bandX + 25, 1);
    }
  });
  it('өндөр = дүн ÷ масштаб × plot; суурь нь plot.height', () => {
    const last = bars[11];
    expect(last.height).toBe(150); // 30M / 40M × 200
    expect(last.y).toBe(50);
    expect(last.y + last.height).toBe(plot.height);
    expect(bars[10].height).toBe(100);
  });
  it('олголтгүй сар: өндөр 0 (багана зурагдахгүй), үнэлгээ хэвээр', () => {
    expect(bars[0].height).toBe(0);
    expect(bars[0].y).toBe(plot.height);
    expect(bars[0].amount).toBe(0);
  });
  it('масштаб 0 бол NaN үүсгэхгүй', () => {
    for (const b of layoutMonthlyBars(monthly, plot, 0)) expect(b.height).toBe(0);
  });
});

describe('сарын шошго', () => {
  it('monthParts', () => {
    expect(monthParts('2026-10')).toEqual({ year: 2026, month: 10 });
    expect(monthParts('2026-13')).toBeNull();
    expect(monthParts('2026-1')).toBeNull();
    expect(monthParts('')).toBeNull();
  });
  it('жилийг эхний багана болон 1-р сард л үзүүлнэ', () => {
    expect(monthAxisLabel('2025-11', 0, tr)).toEqual({ month: '11-р сар', year: '2025' });
    expect(monthAxisLabel('2025-12', 1, tr)).toEqual({ month: '12-р сар', year: null });
    expect(monthAxisLabel('2026-01', 2, tr)).toEqual({ month: '1-р сар', year: '2026' });
    expect(monthAxisLabel('bad', 3, tr)).toEqual({ month: 'bad', year: null });
  });
});

// ── хэвтээ мөрт диаграм ─────────────────────────────────────────────────────────────
describe('agingRows', () => {
  const rows = agingRows(summary().portfolio.aging, 'MNT', tr);
  it('5 хувин үргэлж AgingBucket дарааллаар, байхгүй хувин 0', () => {
    expect(rows.map((r) => r.key)).toEqual([...AgingBucket]);
    expect(rows.map((r) => r.value)).toEqual([60_000_000, 0, 20_000_000, 0, 0]);
    expect(rows[1].primary).toBe('0 ₮');
    expect(rows[1].secondary).toBe('0 зээл');
  });
  it('урт нь хамгийн их утгад харьцуулсан, нэр/утга текстээр', () => {
    expect(rows[0].ratio).toBe(1);
    expect(rows[2].ratio).toBeCloseTo(1 / 3);
    expect(rows[1].ratio).toBe(0);
    expect(rows[0].label).toBe('Хэвийн');
    expect(rows[0].primary).toBe('60,000,000 ₮');
    expect(rows[0].secondary).toBe('8 зээл');
  });
  it('CURRENT → 90+ өнгө хүндэрнэ: тус бүр өөр өнгө, backend-ийн хувин бүрд өнгө бий', () => {
    expect(new Set(rows.map((r) => r.color)).size).toBe(5);
    for (const b of AgingBucket) expect(AGING_COLORS[b], b).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('бүх утга 0 бол ratio 0 (NaN биш)', () => {
    for (const r of agingRows([], 'MNT', tr)) expect(r.ratio).toBe(0);
  });
  it('USD', () => expect(agingRows([{ bucket: 'CURRENT', loanCount: 1, principal: 12.5 }], 'USD', tr)[0].primary).toBe('12.5 USD'));
});

describe('statusRows', () => {
  const rows = statusRows(summary().applications.byStatus, 'MNT', tr);
  it('9 төлөв ApplicationStatus дарааллаар, байхгүй нь 0; нэр нь mn.json-ий status.*', () => {
    expect(rows.map((r) => r.key)).toEqual([...ApplicationStatus]);
    expect(rows.find((r) => r.key === 'SUBMITTED')).toMatchObject({ label: 'Илгээсэн', value: 4, primary: '4', secondary: '40,000,000 ₮' });
    expect(rows.find((r) => r.key === 'DRAFT')).toMatchObject({ value: 0, ratio: 0, label: 'Шинэ' });
    expect(rows.find((r) => r.key === 'ACTIVE')?.ratio).toBe(1);
    expect(rows.every((r) => !r.label.startsWith('!'))).toBe(true);
  });
  it('нэг өнгө (нэг цуваа)', () => expect(new Set(rows.map((r) => r.color))).toEqual(new Set([CHART_COLORS.accent])));
});

describe('productRows', () => {
  it('backend-ийн дарааллаар, дүнгээр урт, productId null-д давхцахгүй түлхүүр', () => {
    const rows = productRows(summary().topProducts, 'MNT', tr);
    expect(rows.map((r) => r.label)).toEqual(['Хэрэглээний зээл', 'Бусад']);
    expect(rows[0]).toMatchObject({ ratio: 1, primary: '60,000,000 ₮', secondary: '6 хүсэлт' });
    expect(rows[1].ratio).toBeCloseTo(0.25);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
  it('хоосон', () => expect(productRows([], 'MNT', tr)).toEqual([]));
});
