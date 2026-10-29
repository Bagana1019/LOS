import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ReportDefinitionView, ReportExportQuery, ReportKey, ReportQuery, ReportResult } from '@los/contracts';
import type { ReportColumn, ReportRow } from '@los/contracts';
import mnBase from '../../../../../packages/ui/src/i18n/mn.json';
import mnReport from '../../../../../packages/ui/src/i18n/mn.report.json';
import {
  DEFAULT_PAGE_SIZE, ERROR_KEYS, PAGE_SIZES, STATUS_COLORS, buildReportQuery, columnAlign, columnPixelWidth, compactFilters, currencyOf, describeError, effectiveSort, exportFileName,
  formatCell, formatDateTimeUb, formatMoneyValue, formatNumberValue, formatPercentValue, formatTotal, isIsoDate, isReportKey, isTransientError, lastPage, nextSort, normalizeFilterValue,
  pageCorrection, parseViewState, retryTransient, sameFilters, statusColor, statusLabel, tableScrollWidth, toAntdOrder, toSearchParams, totalKeysOf, totalsCurrency, validateFilters,
  type Translate,
} from './reports.utils';

const dict = { ...(mnBase as Record<string, string>), ...(mnReport as Record<string, string>) };
/** lib/i18n.ts-ийн t()-тэй ижил: олдохгүй түлхүүрийг "!" угтвартай буцаана (тестэд илрүүлнэ). */
const tr: Translate = (key, params) => {
  const raw = dict[key] ?? `!${key}`;
  return params ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`)) : raw;
};

// ── fixtures ────────────────────────────────────────────────────────────────────────
const col = (key: string, type: ReportColumn['type'], over: Partial<ReportColumn> = {}): ReportColumn => ({ key, label: key, type, sortable: true, ...over });
const BUCKETS = [{ value: 'CURRENT', label: 'Хэвийн' }, { value: 'DPD_1_30', label: '1–30 хоног' }];

/** overdue-loans-тэй төстэй тодорхойлолт. */
const definition = (over: Partial<ReportDefinitionView> = {}): ReportDefinitionView => ({
  key: 'overdue-loans', title: 'Хугацаа хэтэрсэн зээл', description: 'Хугацаа хэтэрсэн зээлүүд', dataSource: 'origination',
  columns: [
    col('contractNo', 'string', { width: 18 }),
    col('registerNo', 'string', { sortable: false }),
    col('dpd', 'number'),
    col('bucket', 'status', { options: BUCKETS }),
    col('overdueTotal', 'money'),
    col('interestRate', 'percent'),
    col('oldestDueDate', 'date'),
    col('currency', 'string'),
  ],
  filters: [
    { key: 'status', label: 'Ангилал', type: 'select', options: BUCKETS },
    { key: 'asOf', label: 'Огноо', type: 'date' },
    { key: 'dateFrom', label: 'Эхлэх', type: 'date' },
    { key: 'dateTo', label: 'Дуусах', type: 'date' },
    { key: 'branchId', label: 'Салбар', type: 'text' },
    { key: 'search', label: 'Хайх', type: 'text' },
  ],
  defaultSort: { sortBy: 'dpd', sortDir: 'desc' },
  ...over,
});
const def = definition();

describe('fixtures нь DTO-той таарна', () => {
  it('ReportDefinitionView', () => expect(ReportDefinitionView.safeParse(def).success).toBe(true));
  it('ReportResult', () => {
    const r = { key: 'overdue-loans', title: 'x', columns: def.columns, rows: [{ contractNo: 'C1', dpd: 3 }], total: 1, page: 1, pageSize: 20, asOf: '2026-10-28', generatedAt: '2026-10-28T09:00:00.000Z' };
    expect(ReportResult.safeParse(r).success).toBe(true);
  });
});

// ── тоо, мөнгө, огноо ───────────────────────────────────────────────────────────────
describe('formatNumberValue', () => {
  it('таслалаар бүлэглэж, сүүлийн тэгийг хасна', () => {
    expect(formatNumberValue(1234567.5)).toBe('1,234,567.5');
    expect(formatNumberValue(1000)).toBe('1,000');
    expect(formatNumberValue(0)).toBe('0');
    expect(formatNumberValue(999)).toBe('999');
    expect(formatNumberValue(12.3456)).toBe('12.35');
    expect(formatNumberValue(1_000_000_000)).toBe('1,000,000,000');
  });
  it('сөрөг тоо, -0', () => {
    expect(formatNumberValue(-1234.5)).toBe('-1,234.5');
    expect(formatNumberValue(-0.001)).toBe('0');
    expect(formatNumberValue(-0)).toBe('0');
  });
  it('нарийвчлал, тоо биш', () => {
    expect(formatNumberValue(2.56, 1)).toBe('2.6');
    expect(formatNumberValue(1234.9, 0)).toBe('1,235');
    expect(formatNumberValue(Number.NaN)).toBe('—');
    expect(formatNumberValue(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatMoneyValue', () => {
  it('MNT → ₮, бусад валют нэрээрээ', () => {
    expect(formatMoneyValue(1250000)).toBe('1,250,000 ₮');
    expect(formatMoneyValue(120.5, 'USD')).toBe('120.5 USD');
    expect(formatMoneyValue(0.1 + 0.2)).toBe('0.3 ₮');
  });
});

describe('formatPercentValue', () => {
  it('харьцааг ×100 хийнэ (0.25 = 25%)', () => {
    expect(formatPercentValue(0.25)).toBe('25%');
    expect(formatPercentValue(0.255)).toBe('25.5%');
    expect(formatPercentValue(0.07)).toBe('7%'); // 0.07*100 = 7.000000000000001
    expect(formatPercentValue(0)).toBe('0%');
    expect(formatPercentValue(1.5)).toBe('150%');
  });
  it('null → —', () => {
    expect(formatPercentValue(null)).toBe('—');
    expect(formatPercentValue(undefined)).toBe('—');
  });
});

describe('formatDateTimeUb', () => {
  it('UTC → Asia/Ulaanbaatar (UTC+8)', () => {
    expect(formatDateTimeUb('2026-10-28T09:05:00.000Z')).toBe('2026-10-28 17:05');
    expect(formatDateTimeUb('2026-10-28T20:00:00.000Z')).toBe('2026-10-29 04:00'); // өдөр шилжинэ
  });
  it('буруу утгыг хэвээр буцаана', () => expect(formatDateTimeUb('nope')).toBe('nope'));
});

describe('isIsoDate', () => {
  it('бодит календарийн өдөр', () => {
    expect(isIsoDate('2026-10-28')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-02-31')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-1-1')).toBe(false);
    expect(isIsoDate('')).toBe(false);
    expect(isIsoDate('28/10/2026')).toBe(false);
  });
});

describe('exportFileName', () => {
  it('backend-ийн нэртэй ижил: LOS_<key>_<YYYYMMDD>.xlsx', () => {
    expect(exportFileName('overdue-loans', '2026-10-28')).toBe('LOS_overdue-loans_20261028.xlsx');
    expect(exportFileName('overdue-loans')).toBe('LOS_overdue-loans.xlsx');
    expect(exportFileName('overdue-loans', 'bad')).toBe('LOS_overdue-loans.xlsx');
  });
});

// ── баганы утгыг харуулах ───────────────────────────────────────────────────────────
describe('formatCell', () => {
  const row: ReportRow = { currency: 'USD', amount: 1500.5, ratio: 0.18, n: 3, d: '2026-10-05', s: 'abc', st: 'DPD_1_30', flag: true };
  it('money нь мөрийн валютаар', () => {
    expect(formatCell(col('amount', 'money'), 1500.5, row)).toBe('1,500.5 USD');
    expect(formatCell(col('amount', 'money'), 1500, { currency: 'MNT' })).toBe('1,500 ₮');
    expect(formatCell(col('amount', 'money'), 1500, {})).toBe('1,500 ₮'); // валютгүй мөр → MNT
  });
  it('percent, number, date, string', () => {
    expect(formatCell(col('ratio', 'percent'), 0.18, row)).toBe('18%');
    expect(formatCell(col('n', 'number'), 12345, row)).toBe('12,345');
    expect(formatCell(col('d', 'date'), '2026-10-05', row)).toBe('2026-10-05');
    expect(formatCell(col('s', 'string'), 'abc', row)).toBe('abc');
  });
  it('status нь column.options-оос шошго авна, үл мэдэгдэх код хэвээр', () => {
    const c = col('st', 'status', { options: BUCKETS });
    expect(formatCell(c, 'DPD_1_30', row)).toBe('1–30 хоног');
    expect(formatCell(c, 'WHATEVER', row)).toBe('WHATEVER');
    expect(statusLabel(col('x', 'status'), 'CODE')).toBe('CODE');
  });
  it('null/хоосон → —', () => {
    for (const type of ['string', 'number', 'money', 'date', 'percent', 'status'] as const) {
      expect(formatCell(col('x', type), null, row), type).toBe('—');
      expect(formatCell(col('x', type), undefined, row), type).toBe('—');
      expect(formatCell(col('x', type), '', row), type).toBe('—');
    }
  });
  it('0 нь хоосон биш', () => {
    expect(formatCell(col('x', 'money'), 0, row)).toBe('0 USD');
    expect(formatCell(col('x', 'number'), 0, row)).toBe('0');
    expect(formatCell(col('x', 'percent'), 0, row)).toBe('0%');
  });
  it('boolean, төрөл таараагүй утга', () => {
    expect(formatCell(col('flag', 'string'), true, row, tr)).toBe('Тийм');
    expect(formatCell(col('flag', 'string'), false, row, tr)).toBe('Үгүй');
    expect(formatCell(col('amount', 'money'), '12', row)).toBe('12');
  });
  it('currencyOf', () => {
    expect(currencyOf({ currency: 'USD' })).toBe('USD');
    expect(currencyOf({ currency: '' })).toBe('MNT');
    expect(currencyOf({ currency: 5 })).toBe('MNT');
    expect(currencyOf({}, 'USD')).toBe('USD');
  });
});

describe('баганы тохиргоо', () => {
  it('тоон баганууд баруун тийш', () => {
    for (const t of ['money', 'number', 'percent'] as const) expect(columnAlign(t)).toBe('right');
    for (const t of ['string', 'date', 'status'] as const) expect(columnAlign(t)).toBe('left');
  });
  it('өргөн: Excel-ийн тэмдэгт → пиксел, хязгаартай', () => {
    expect(columnPixelWidth(undefined)).toBe(150);
    expect(columnPixelWidth(1)).toBe(80);
    expect(columnPixelWidth(18)).toBe(186);
    expect(columnPixelWidth(100)).toBe(360);
    expect(tableScrollWidth([{ width: 18 }, { width: undefined }])).toBe(186 + 150);
  });
  it('statusColor: тодорхой төлөвт өнгө, үл мэдэгдэх → default', () => {
    expect(statusColor('ACTIVE')).toBe('green');
    expect(statusColor('DPD_90_PLUS')).toBe('volcano');
    expect(statusColor('EXPIRING')).toBe('orange');
    expect(statusColor('???')).toBe('default');
  });
});

// ── нийлбэр ─────────────────────────────────────────────────────────────────────────
describe('нийлбэр мөр', () => {
  it('зөвхөн money/number баганад, totals-д байгаа түлхүүрээр', () => {
    expect(totalKeysOf(def.columns, { overdueTotal: 100, dpd: 5, interestRate: 1, contractNo: 2 })).toEqual(['dpd', 'overdueTotal']);
    expect(totalKeysOf(def.columns, undefined)).toEqual([]);
  });
  it('валют: эхний мөрөөс, хоосон бол шүүлт, үгүй бол MNT', () => {
    expect(totalsCurrency([{ currency: 'USD' }])).toBe('USD');
    expect(totalsCurrency([], 'USD')).toBe('USD');
    expect(totalsCurrency([], null)).toBe('MNT');
    expect(totalsCurrency([{}], 'USD')).toBe('USD');
  });
  it('formatTotal', () => {
    expect(formatTotal(col('a', 'money'), 1250.75, 'MNT')).toBe('1,250.75 ₮');
    expect(formatTotal(col('a', 'number'), 12, 'MNT')).toBe('12');
  });
});

// ── эрэмбэ, хуудаслалт ──────────────────────────────────────────────────────────────
describe('эрэмбэ', () => {
  const none = { sortBy: null, sortDir: 'asc' as const };
  it('effectiveSort: сонгоогүй бол анхдагч', () => {
    expect(effectiveSort(none, def)).toEqual({ sortBy: 'dpd', sortDir: 'desc' });
    expect(effectiveSort({ sortBy: 'contractNo', sortDir: 'asc' }, def)).toEqual({ sortBy: 'contractNo', sortDir: 'asc' });
    expect(effectiveSort(none, { defaultSort: undefined })).toBeNull();
  });
  it('antd-ийн order → шууд хөрвүүлнэ', () => {
    expect(nextSort(none, def, 'contractNo', 'ascend')).toEqual({ sortBy: 'contractNo', sortDir: 'asc' });
    expect(nextSort(none, def, 'contractNo', 'descend')).toEqual({ sortBy: 'contractNo', sortDir: 'desc' });
  });
  it('идэвхтэй баганыг 3 дахь дарахад (order=undefined) чиглэл эсрэгээр — "эрэмбэгүй" төлөвт орохгүй', () => {
    expect(nextSort(none, def, 'dpd', undefined)).toEqual({ sortBy: 'dpd', sortDir: 'asc' }); // анхдагч desc → asc
    expect(nextSort({ sortBy: 'dpd', sortDir: 'asc' }, def, 'dpd', null)).toEqual({ sortBy: 'dpd', sortDir: 'desc' });
    expect(nextSort({ sortBy: 'contractNo', sortDir: 'desc' }, def, 'contractNo', undefined)).toEqual({ sortBy: 'contractNo', sortDir: 'asc' });
  });
  it('өөр баганад цуцлалт ирвэл өсөхөөр эхэлнэ; багана үл мэдэгдвэл өөрчлөхгүй', () => {
    expect(nextSort(none, def, 'contractNo', undefined)).toEqual({ sortBy: 'contractNo', sortDir: 'asc' });
    expect(nextSort(none, def, undefined, 'ascend')).toBe(none);
  });
  it('toAntdOrder: зөвхөн идэвхтэй баганад', () => {
    const a = { sortBy: 'dpd', sortDir: 'desc' as const };
    expect(toAntdOrder(a, 'dpd')).toBe('descend');
    expect(toAntdOrder({ sortBy: 'dpd', sortDir: 'asc' }, 'dpd')).toBe('ascend');
    expect(toAntdOrder(a, 'contractNo')).toBeNull();
    expect(toAntdOrder(null, 'dpd')).toBeNull();
  });
  it('lastPage, pageCorrection', () => {
    expect(lastPage(0, 20)).toBe(1);
    expect(lastPage(41, 20)).toBe(3);
    expect(lastPage(40, 20)).toBe(2);
    const empty = { rows: [], total: 41, page: 5, pageSize: 20 };
    expect(pageCorrection(empty)).toBe(3);
    expect(pageCorrection({ ...empty, total: 0 })).toBeNull(); // үнэхээр хоосон
    expect(pageCorrection({ ...empty, page: 1 })).toBeNull();
    expect(pageCorrection({ ...empty, rows: [{}] })).toBeNull();
    expect(pageCorrection(undefined)).toBeNull();
  });
});

// ── шүүлт ба URL ────────────────────────────────────────────────────────────────────
const sp = (q: string) => new URLSearchParams(q);

describe('normalizeFilterValue', () => {
  const f = (type: 'text' | 'date' | 'select' | 'number', options?: Array<{ value: string; label: string }>) => ({ type, options });
  it('хоосон, зай → null', () => {
    expect(normalizeFilterValue(f('text'), '  ')).toBeNull();
    expect(normalizeFilterValue(f('text'), null)).toBeNull();
  });
  it('date: бодит өдөр', () => {
    expect(normalizeFilterValue(f('date'), '2026-10-28')).toBe('2026-10-28');
    expect(normalizeFilterValue(f('date'), '2026-02-31')).toBeNull();
  });
  it('select: options-д байх ёстой, options-гүй бол текст', () => {
    expect(normalizeFilterValue(f('select', BUCKETS), 'CURRENT')).toBe('CURRENT');
    expect(normalizeFilterValue(f('select', BUCKETS), 'NOPE')).toBeNull();
    expect(normalizeFilterValue(f('select'), 'X')).toBe('X');
  });
  it('number, text (trim, 100 тэмдэгтээр хязгаарлана)', () => {
    expect(normalizeFilterValue(f('number'), '12.5')).toBe('12.5');
    expect(normalizeFilterValue(f('number'), 'abc')).toBeNull();
    expect(normalizeFilterValue(f('text'), '  Бат  ')).toBe('Бат');
    expect(normalizeFilterValue(f('text'), 'x'.repeat(150))).toHaveLength(100);
  });
});

describe('parseViewState', () => {
  it('анхдагч утга', () => {
    expect(parseViewState(sp(''), def)).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE, sortBy: null, sortDir: 'asc', filters: {} });
  });
  it('зөв утгууд', () => {
    const s = parseViewState(sp('page=3&pageSize=50&sortBy=overdueTotal&sortDir=desc&status=CURRENT&dateFrom=2026-01-01&dateTo=2026-02-01&search=Бат&branchId=b1'), def);
    expect(s).toEqual({
      page: 3, pageSize: 50, sortBy: 'overdueTotal', sortDir: 'desc',
      filters: { status: 'CURRENT', dateFrom: '2026-01-01', dateTo: '2026-02-01', search: 'Бат', branchId: 'b1' },
    });
  });
  it('буруу page/pageSize → анхдагч', () => {
    for (const q of ['page=0', 'page=-1', 'page=abc', 'page=1.5', 'page=99999999999']) expect(parseViewState(sp(q), def).page, q).toBe(1);
    for (const q of ['pageSize=15', 'pageSize=0', 'pageSize=1000', 'pageSize=x']) expect(parseViewState(sp(q), def).pageSize, q).toBe(DEFAULT_PAGE_SIZE);
    for (const size of PAGE_SIZES) expect(parseViewState(sp(`pageSize=${size}`), def).pageSize).toBe(size);
  });
  it('whitelist-д байхгүй/эрэмбэлэх боломжгүй багана → анхдагч эрэмбэ (INVALID_SORT-оос сэргийлнэ)', () => {
    expect(parseViewState(sp('sortBy=registerNo&sortDir=desc'), def)).toMatchObject({ sortBy: null, sortDir: 'asc' });
    expect(parseViewState(sp('sortBy=nope'), def).sortBy).toBeNull();
    expect(parseViewState(sp('sortBy=dpd&sortDir=sideways'), def)).toMatchObject({ sortBy: 'dpd', sortDir: 'asc' });
  });
  it('тодорхойлолтод байхгүй, буруу утгатай шүүлтийг хаяна', () => {
    const s = parseViewState(sp('status=NOPE&dateFrom=2026-02-31&productId=p1&unknown=1'), def);
    expect(s.filters).toEqual({});
  });
});

describe('toSearchParams ↔ parseViewState', () => {
  it('анхдагч утгыг URL-д оруулахгүй', () => {
    expect(toSearchParams({ page: 1, pageSize: 20, sortBy: null, sortDir: 'asc', filters: {} }).toString()).toBe('');
  });
  it('round-trip', () => {
    const state = { page: 4, pageSize: 100, sortBy: 'overdueTotal', sortDir: 'desc' as const, filters: { status: 'CURRENT', search: 'Бат Эрдэнэ', dateFrom: '2026-01-01' } };
    const url = toSearchParams(state).toString();
    expect(parseViewState(new URLSearchParams(url), def)).toEqual(state);
  });
});

describe('buildReportQuery (backend гэрээ)', () => {
  const state = { page: 2, pageSize: 50, sortBy: 'overdueTotal', sortDir: 'desc' as const, filters: { status: 'CURRENT', branchId: 'b1', search: 'Бат', dateFrom: '2026-01-01', ghost: 'x' } };
  it('JSON хуудас: page, pageSize, sort, шүүлт; тодорхойлолтод байхгүй шүүлтийг явуулахгүй', () => {
    const q = buildReportQuery(state, def, { paging: true });
    expect(q).toEqual({ page: 2, pageSize: 50, sortBy: 'overdueTotal', sortDir: 'desc', status: 'CURRENT', branchId: 'b1', search: 'Бат', dateFrom: '2026-01-01' });
    expect(ReportQuery.safeParse(q).success).toBe(true);
  });
  it('Excel: хуудаслалтгүй (ReportExportQuery)', () => {
    const q = buildReportQuery(state, def, { paging: false });
    expect(q).not.toHaveProperty('page');
    expect(q).not.toHaveProperty('pageSize');
    expect(ReportExportQuery.safeParse(q).success).toBe(true);
  });
  it('эрэмбэ сонгоогүй бол sortBy/sortDir явуулахгүй (сервер анхдагчийг хэрэглэнэ)', () => {
    const q = buildReportQuery({ ...state, sortBy: null }, def, { paging: true });
    expect(q).not.toHaveProperty('sortBy');
    expect(q).not.toHaveProperty('sortDir');
  });
  it('анхдагч төлөв нь ReportQuery-д таарна', () => {
    const q = buildReportQuery(parseViewState(sp(''), def), def, { paging: true });
    expect(ReportQuery.parse(q)).toMatchObject({ page: 1, pageSize: 20 });
  });
});

describe('шүүлтийн форм', () => {
  it('validateFilters: эхлэх огноо дуусахаас хойно бол алдаа', () => {
    expect(validateFilters({ dateFrom: '2026-02-01', dateTo: '2026-01-01' })).toBe('report.filters.error.dateRange');
    expect(validateFilters({ dateFrom: '2026-01-01', dateTo: '2026-01-01' })).toBeNull();
    expect(validateFilters({ dateFrom: '2026-02-01' })).toBeNull();
    expect(validateFilters({})).toBeNull();
  });
  it('compactFilters: хоосон, буруу утгыг хасна', () => {
    expect(compactFilters({ status: 'CURRENT', search: '  ', dateFrom: 'bad', branchId: ' b1 ', ghost: 'x' }, def.filters)).toEqual({ status: 'CURRENT', branchId: 'b1' });
  });
  it('sameFilters', () => {
    expect(sameFilters({ a: '1', b: '2' }, { b: '2', a: '1' })).toBe(true);
    expect(sameFilters({ a: '1' }, { a: '1', b: '2' })).toBe(false);
    expect(sameFilters({ a: '1' }, { a: '2' })).toBe(false);
    expect(sameFilters({}, {})).toBe(true);
  });
  it('isReportKey', () => {
    for (const k of ReportKey) expect(isReportKey(k)).toBe(true);
    expect(isReportKey('dashboard')).toBe(false);
    expect(isReportKey('')).toBe(false);
  });
});

// ── алдаа ───────────────────────────────────────────────────────────────────────────
describe('describeError', () => {
  const api = (status: number, code: string | null, message = 'серверийн мессеж', issues?: unknown) => ({ status, code, message, issues });

  it('backend-ийн код бүр монгол мессежтэй', () => {
    for (const [code, key] of Object.entries(ERROR_KEYS)) {
      const d = describeError(api(400, code, ''), tr);
      expect(d.code).toBe(code);
      expect(d.message, code).toBe(dict[key]);
      expect(d.message.startsWith('!'), code).toBe(false);
    }
  });
  it('EXPORT_TOO_LARGE, INVALID_FILTER, INVALID_SORT дээр серверийн мессеж (динамик) түрүүлнэ', () => {
    expect(describeError(api(422, 'EXPORT_TOO_LARGE', 'Экспортлох мөрийн тоо (60000) хэтэрсэн'), tr).message).toBe('Экспортлох мөрийн тоо (60000) хэтэрсэн');
    expect(describeError(api(400, 'INVALID_FILTER', '"Ангилал" шүүлтийн утга буруу: X'), tr).message).toContain('Ангилал');
    expect(describeError(api(400, 'INVALID_SORT', '"x" баганаар эрэмбэлэх боломжгүй'), tr).message).toContain('"x"');
  });
  it('VALIDATION_FAILED: талбар бүрийн тайлбар', () => {
    const d = describeError(api(400, 'VALIDATION_FAILED', 'Оролтын өгөгдөл буруу', [{ path: 'pageSize', message: 'pageSize 10/20/50/100' }, { path: '', message: 'Буруу' }, { message: ' ' }]), tr);
    expect(d.message).toBe('Шүүлтийн утга буруу байна');
    expect(d.issues).toEqual(['pageSize: pageSize 10/20/50/100', 'Буруу']);
  });
  it('apiDownload нь код өгөхгүй (code=null) — статусаас сэргээнэ', () => {
    const e422 = describeError(api(422, null, 'Unprocessable Entity'), tr);
    expect(e422.code).toBe('EXPORT_TOO_LARGE');
    expect(e422.message).toBe(dict['report.error.EXPORT_TOO_LARGE']); // statusText биш
    expect(describeError(api(501, null, 'Not Implemented'), tr).code).toBe('INTEGRATION_NOT_IMPLEMENTED');
    expect(describeError(api(401, null), tr).code).toBe('UNAUTHENTICATED');
    expect(describeError(api(403, null), tr).code).toBe('FORBIDDEN');
    expect(describeError(api(404, null), tr).code).toBe('REPORT_NOT_FOUND');
    expect(describeError(api(429, null, 'Too Many Requests'), tr).code).toBe('EXPORT_BUSY');
    expect(describeError(api(504, null, 'Gateway Timeout'), tr).code).toBe('REPORT_TIMEOUT');
    expect(describeError(api(504, null, 'Gateway Timeout'), tr).message).toBe(dict['report.error.REPORT_TIMEOUT']);
  });
  it('ачаалал/timeout (429, 504): гараар дахин оролдож болно, автоматаар дахин оролдохгүй; error severity', () => {
    for (const [status, code] of [[429, 'EXPORT_BUSY'], [429, 'REPORT_BUSY'], [504, 'REPORT_TIMEOUT']] as const) {
      const e = api(status, code);
      expect(describeError(e, tr).retryable, code).toBe(true);
      expect(describeError(e, tr).severity, code).toBe('error');
      expect(isTransientError(e), code).toBe(false);
      expect(retryTransient(0, e), code).toBe(false);
    }
    expect(describeError(api(504, null), tr).retryable).toBe(true); // apiDownload (код байхгүй)
    expect(describeError(api(502, null), tr).retryable).toBe(true);
  });
  it('Core интеграцийн алдаа нь анхааруулга (warning), бусад нь error', () => {
    expect(describeError(api(503, 'INTEGRATION_NOT_CONFIGURED'), tr).severity).toBe('warning');
    expect(describeError(api(501, 'INTEGRATION_NOT_IMPLEMENTED'), tr).severity).toBe('warning');
    expect(describeError(api(403, 'FORBIDDEN'), tr).severity).toBe('error');
    expect(describeError(api(500, null), tr).severity).toBe('error');
  });
  it('5xx, сүлжээ, үл мэдэгдэх', () => {
    expect(describeError(api(500, null), tr).message).toBe(dict['report.error.SERVER']);
    expect(describeError(api(503, null), tr).message).toBe(dict['report.error.SERVER']); // кодгүй 503 = gateway/сервер
    expect(describeError(new TypeError('Failed to fetch'), tr).message).toBe(dict['report.error.NETWORK']);
    expect(describeError(null, tr).message).toBe(dict['report.error.UNKNOWN']);
    expect(describeError(undefined, tr).message).toBe(dict['report.error.UNKNOWN']);
    expect(describeError(api(409, null, 'Зөрчил'), tr).message).toBe('Зөрчил');
  });
  it('retryable: зөвхөн түр зуурын алдаа', () => {
    expect(describeError(api(500, null), tr).retryable).toBe(true);
    expect(describeError(new TypeError('x'), tr).retryable).toBe(true);
    expect(describeError(api(400, 'INVALID_SORT'), tr).retryable).toBe(false);
    expect(describeError(api(403, 'FORBIDDEN'), tr).retryable).toBe(false);
    expect(describeError(api(503, 'INTEGRATION_NOT_CONFIGURED'), tr).retryable).toBe(false);
    expect(describeError(api(501, 'INTEGRATION_NOT_IMPLEMENTED'), tr).retryable).toBe(false);
  });
  it('isTransientError / retryTransient: 4xx, 501 дахин оролдохгүй; нэг л удаа', () => {
    expect(isTransientError(api(404, 'REPORT_NOT_FOUND'))).toBe(false);
    expect(isTransientError(api(502, null))).toBe(true);
    expect(isTransientError(new TypeError('x'))).toBe(true);
    expect(retryTransient(0, api(500, null))).toBe(true);
    expect(retryTransient(1, api(500, null))).toBe(false);
    expect(retryTransient(0, api(403, 'FORBIDDEN'))).toBe(false);
  });
});

// ── backend-тэй уялдаа (унших зөвхөн) ───────────────────────────────────────────────
describe('backend гэрээ', () => {
  const dir = fileURLToPath(new URL('../../../../origination/src/modules/report/', import.meta.url));
  const sources = (): Array<{ file: string; text: string }> => {
    const out: Array<{ file: string; text: string }> = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = `${d}${e.name}`;
        if (e.isDirectory()) walk(`${p}/`);
        else if (e.name.endsWith('.ts') && !/\.(test|fixtures|test-helpers)\./.test(e.name)) out.push({ file: e.name, text: readFileSync(p, 'utf8') });
      }
    };
    walk(dir);
    return out;
  };

  it.skipIf(!existsSync(dir))('report модулийн алдааны код бүрийг UI таньдаг', () => {
    const codes = new Set<string>();
    for (const { text } of sources()) {
      for (const m of text.matchAll(/code: '([A-Z_]+)'/g)) codes.add(m[1]);
      for (const m of text.matchAll(/\bbad\('([A-Z_]+)'/g)) codes.add(m[1]);
    }
    // report.fixtures-ээс бусад: BUSINESS/CONSUMER нь харилцагчийн төрөл тул шүүгдсэн (fixtures хасагдсан)
    expect(codes.size).toBeGreaterThanOrEqual(8);
    expect([...codes].filter((c) => !(c in ERROR_KEYS)), 'UI танихгүй backend код').toEqual([]);
  });

  it.skipIf(!existsSync(dir))('backend-ийн хуудаслалтын хэмжээ UI-тай ижил (10/20/50/100)', () => {
    expect(ReportQuery.safeParse({ pageSize: 15 }).success).toBe(false);
    for (const size of PAGE_SIZES) expect(ReportQuery.safeParse({ pageSize: size }).success).toBe(true);
    expect(ReportQuery.parse({}).pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it.skipIf(!existsSync(dir))('status/select төрлийн төлөв бүрт UI-ийн өнгө тодорхой (reports/*.report.ts + report-labels.ts)', () => {
    const labels = readFileSync(`${dir}report-labels.ts`, 'utf8');
    const sets = new Map<string, string[]>();
    for (const m of labels.matchAll(/export const (\w+) = opts\(\{([\s\S]*?)\}\);/g)) sets.set(m[1], [...m[2].matchAll(/(\w+):\s*'/g)].map((k) => k[1]));
    for (const m of labels.matchAll(/export const (\w+) = \w+\.filter\(/g)) sets.set(m[1], []); // бусдаас шүүсэн дэд олонлог (REPAYING_STATUS)
    // Төлөв байдлыг илтгэдэг (өнгөөр ялгах ёстой) олонлогууд
    const STATE_SETS = ['APPLICATION_STATUS', 'AGING_BUCKET', 'DISBURSEMENT_STATUS', 'COLLATERAL_STATUS', 'ENCUMBRANCE_STATUS', 'DEPOSIT_STATUS', 'STEP_STATUS'];
    for (const name of STATE_SETS) {
      const values = sets.get(name);
      expect(values?.length, name).toBeGreaterThan(1);
      expect(values?.filter((v) => !(v in STATUS_COLORS)), `${name}: өнгөгүй төлөв`).toEqual([]);
    }
    // Тайлан бүрийн status багана ашиглаж буй олонлог нь report-labels-д бий
    const used = new Set<string>();
    for (const { file, text } of sources().filter((s) => s.file.endsWith('.report.ts'))) {
      for (const m of text.matchAll(/'status',\s*\{[^}]*options:\s*([A-Z_]+)/g)) used.add(`${file}:${m[1]}`);
    }
    expect(used.size).toBeGreaterThan(5);
    for (const u of used) expect(sets.has(u.split(':')[1]), u).toBe(true);
  });

  it.skipIf(!existsSync(dir))('баганы төрөл бүрийг UI форматлаж чадна', () => {
    const types = new Set<string>();
    for (const { text } of sources().filter((s) => s.file.endsWith('.report.ts'))) {
      for (const m of text.matchAll(/col\('\w+',\s*'[^']*',\s*'(\w+)'/g)) types.add(m[1]);
    }
    expect([...types].sort()).toEqual(['date', 'money', 'number', 'percent', 'status', 'string']);
  });
});
