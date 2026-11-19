import { describe, expect, it } from 'vitest';
import type { OrgDirectory, ReportRow } from '@los/contracts';
import { col } from './report-filters';
import { applyDirectoryNames, hasDirectoryColumns } from './report-directory';

// Excel/CSV экспорт: салбар / ЗЭЗ-ийн UUID → харуулах нэр. Нэр олдохгүй бол id хэвээр (нэр дутсанаас экспорт унахгүй).
const dir: OrgDirectory = { branches: { b1: 'Төв салбар' }, users: { u1: 'Бат Болд' } };
const columns = [col('contractNo', 'Гэрээ', 'string'), col('branchId', 'Салбар', 'string'), col('officerId', 'ЗЭЗ', 'string')];

describe('hasDirectoryColumns', () => {
  it('branchId эсвэл officerId багана байвал true', () => {
    expect(hasDirectoryColumns(columns)).toBe(true);
    expect(hasDirectoryColumns([col('officerId', 'ЗЭЗ', 'string')])).toBe(true);
  });

  it('id багана байхгүй тайланд false (лавлах дуудахгүй)', () => {
    expect(hasDirectoryColumns([col('contractNo', 'Гэрээ', 'string'), col('productName', 'Бүтээгдэхүүн', 'string')])).toBe(false);
    expect(hasDirectoryColumns([])).toBe(false);
  });
});

describe('applyDirectoryNames', () => {
  const rows: ReportRow[] = [
    { contractNo: 'C1', branchId: 'b1', officerId: 'u1' },
    { contractNo: 'C2', branchId: 'b1', officerId: 'Систем' },
    { contractNo: 'C3', branchId: 'b-gone', officerId: 'u-gone' },
    { contractNo: 'C4', branchId: null, officerId: null },
  ];

  it('branchId → салбарын нэр, officerId → ажилтны бүтэн нэр; бусад багана хэвээр', () => {
    const out = applyDirectoryNames(columns, rows, dir);
    expect(out[0]).toEqual({ contractNo: 'C1', branchId: 'Төв салбар', officerId: 'Бат Болд' });
  });

  it('лавлахад байхгүй id → id хэвээр; "Систем" (ЗЭЗ-гүй хүсэлт) хэвээр; null хэвээр', () => {
    const out = applyDirectoryNames(columns, rows, dir);
    expect(out[1]).toMatchObject({ branchId: 'Төв салбар', officerId: 'Систем' });
    expect(out[2]).toMatchObject({ branchId: 'b-gone', officerId: 'u-gone' });
    expect(out[3]).toMatchObject({ branchId: null, officerId: null });
  });

  it('оролтыг мутацилахгүй (шинэ мөр буцаана)', () => {
    const before = JSON.stringify(rows);
    const out = applyDirectoryNames(columns, rows, dir);
    expect(JSON.stringify(rows)).toBe(before);
    expect(out).not.toBe(rows);
    expect(out[0]).not.toBe(rows[0]);
  });

  it('тайлангийн баганад branchId/officerId байхгүй бол мөрүүдийг тэр чигээр нь буцаана', () => {
    expect(applyDirectoryNames([col('contractNo', 'Гэрээ', 'string')], rows, dir)).toBe(rows);
  });

  it('хоосон лавлахтай (лавлах унасан) бүх id хэвээр', () => {
    const out = applyDirectoryNames(columns, rows, { branches: {}, users: {} });
    expect(out).toEqual(rows);
  });

  it('тоон/boolean утгыг (id биш) үл хөрвүүлнэ', () => {
    const odd: ReportRow[] = [{ contractNo: 'C', branchId: 5, officerId: true }];
    expect(applyDirectoryNames(columns, odd, dir)).toEqual(odd);
  });
});
