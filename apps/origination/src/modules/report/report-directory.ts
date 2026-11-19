import type { OrgDirectory, ReportColumn, ReportRow } from '@los/contracts';
import { directoryName } from '../../shared/org-directory';

/** Excel/CSV: UUID хадгалдаг баганы түлхүүр → gateway лавлахын ямар map-аас нэр авах вэ. Бусад багана (бүтээгдэхүүн, харилцагч) SQL-ээс нэрээр нь ирдэг. */
export const DIRECTORY_COLUMNS = { branchId: 'branches', officerId: 'users' } as const satisfies Record<string, keyof OrgDirectory>;

const isDirectoryKey = (key: string): key is keyof typeof DIRECTORY_COLUMNS => Object.hasOwn(DIRECTORY_COLUMNS, key);

export const hasDirectoryColumns = (columns: readonly ReportColumn[]): boolean => columns.some((c) => isDirectoryKey(c.key));

/** Мөрүүдийн салбар / ЗЭЗ-ийн id-г нэр болгоно (шинэ мөр буцаана). Нэр олдохгүй id ("Систем" зэрэг), null хэвээр. */
export function applyDirectoryNames(columns: readonly ReportColumn[], rows: ReportRow[], dir: OrgDirectory): ReportRow[] {
  const keys = columns.map((c) => c.key).filter(isDirectoryKey);
  if (!keys.length) return rows;
  return rows.map((row) => {
    const next: ReportRow = { ...row };
    for (const key of keys) {
      const v = row[key];
      if (typeof v === 'string') next[key] = directoryName(dir[DIRECTORY_COLUMNS[key]], v);
    }
    return next;
  });
}
