// Хүснэгтийн толгой таних (синонимын олонлог): нүд бүрийг toMatchKey-ээр нормчилж, хамгийн урт синонимыг бүтэн үгээр тулгана.
// BSA-FR-2.2, NFR-9 (кирилл/латин холимог).
import { toMatchKey } from '@los/ocr';
import type { StatementTextLine } from '../statement.types';
import type { ColumnRole } from './bank-profile';
import { COLUMN_ROLES } from './bank-profile';
import { DEFAULT_COLUMN_SYNONYMS, type EngineConfig } from './defaults';
import { rowCells } from './text-utils';

export interface TableHeader {
  /** Нүд бүрийн үүрэг (null = танигдаагүй/ашиглахгүй). cellMapped=false бол синонимын гарсан дарааллаар */
  roles: Array<ColumnRole | null>;
  cellCount: number;
  /** true: толгойн нүд бүр мөрийн нүдтэй байрлалаар таарна */
  cellMapped: boolean;
  /** debit/credit/amount/balance — толгойн дарааллаар */
  numericRoles: ColumnRole[];
  /** Толгойд 'description' багана таниагдсан. Үгүй бол таниагдаагүй баганын агуулга тайлбар болно */
  hasDescription: boolean;
  /** date/time/seq угтварын дараах бүх үүрэг (тайлбар, дүн, төрөл, харьцсан данс...) — нүд хасагдсан мөрийг тулгахад */
  bodyRoles: Array<ColumnRole | null>;
}

export interface ColumnMatcher {
  /** Нэг нүдний үүрэг (хамгийн урт синоним), үгүй бол null */
  roleOf(cellText: string): ColumnRole | null;
  /** Нэг нүдтэй толгойн мөрийн текстээс синонимуудыг гарсан дарааллаар нь */
  scan(text: string): ColumnRole[];
  /**
   * Мөр хүснэгтийн толгой мөн бол TableHeader, үгүй бол null. known = одоогийн толгой: нүдээр тасалсан толгойтой хуулгад давтагдсан
   * толгой мөн нүдтэй байх тул нэг нүдтэй мөрийг үнэтэй синоним хайлтаар шалгахгүй.
   */
  detectHeader(line: StatementTextLine, known?: TableHeader | null): TableHeader | null;
}

interface Entry {
  role: ColumnRole;
  key: string;
}

const NUMERIC_ROLES: ReadonlySet<ColumnRole> = new Set(['debit', 'credit', 'amount', 'balance']);
const PREFIX_ROLES: ReadonlySet<ColumnRole> = new Set(['seq', 'date', 'time']);
/** Толгойн мөр биш гэж шууд хаах дээд урт (мөр дотор тайлбар байвал толгой биш) */
const HEADER_MAX_LENGTH = 400;

/** Синонимын жагсаалт (анхдагч + profile-ийн нэмэлт). Урт нь эхэнд → хамгийн урт таарсан нь ялна. */
export function compileColumnMatcher(cfg: EngineConfig, extra: Partial<Record<ColumnRole, string[]>> = {}): ColumnMatcher {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const role of COLUMN_ROLES) {
    for (const syn of [...DEFAULT_COLUMN_SYNONYMS[role], ...(extra[role] ?? [])]) {
      const key = toMatchKey(syn);
      if (key === '' || seen.has(`${role}|${key}`)) continue;
      seen.add(`${role}|${key}`);
      entries.push({ role, key });
    }
  }
  entries.sort((a, b) => b.key.length - a.key.length);

  const roleOf = (cellText: string): ColumnRole | null => {
    if (cellText.length > 80) return null;
    const key = toMatchKey(cellText);
    if (key === '') return null;
    const padded = ` ${key} `;
    for (const e of entries) if (padded.includes(` ${e.key} `)) return e.role;
    return null;
  };

  const scan = (text: string): ColumnRole[] => {
    let rest = ` ${toMatchKey(text)} `;
    const hits: Array<{ at: number; role: ColumnRole }> = [];
    for (const e of entries) {
      const needle = ` ${e.key} `;
      let from = 0;
      for (;;) {
        const at = rest.indexOf(needle, from);
        if (at < 0) break;
        hits.push({ at, role: e.role });
        // таарсан хэсгийг устгаж (ижил урттай зайгаар) богино синоним дахин давхар таарахаас сэргийлнэ
        rest = rest.slice(0, at) + ' '.repeat(needle.length) + rest.slice(at + needle.length);
        from = at + needle.length;
      }
    }
    return hits.sort((a, b) => a.at - b.at).map((h) => h.role);
  };

  const build = (roles: Array<ColumnRole | null>, cellMapped: boolean): TableHeader | null => {
    // Давхардсан date/time/balance-ийн эхнийхийг л үлдээнэ (хоёр дахь огноо = үнэт цаасны огноо гэх мэт → ignore)
    const seenRoles = new Set<ColumnRole>();
    const clean = roles.map((r) => {
      if (r === null || r === 'description' || r === 'ignore' || r === 'ignoreAmount' || r === 'seq') return r;
      if (seenRoles.has(r)) return 'ignore';
      seenRoles.add(r);
      return r;
    });
    const distinct = new Set(clean.filter((r): r is ColumnRole => r !== null && r !== 'ignore' && r !== 'ignoreAmount'));
    const money = [...distinct].filter((r) => NUMERIC_ROLES.has(r));
    if (distinct.size < cfg.tableHeaderMinRoles || !distinct.has('date') || money.length === 0) return null;
    const numericAt = clean.map((r, i) => (r !== null && NUMERIC_ROLES.has(r) ? i : -1)).filter((i) => i >= 0);
    const first = numericAt[0];
    let prefixEnd = -1;
    clean.forEach((r, i) => {
      if (i < first && r !== null && PREFIX_ROLES.has(r)) prefixEnd = i;
    });
    return {
      roles: clean,
      cellCount: clean.length,
      cellMapped,
      numericRoles: numericAt.map((i) => clean[i] as ColumnRole),
      hasDescription: distinct.has('description'),
      bodyRoles: clean.slice(prefixEnd + 1),
    };
  };

  const detectHeader = (line: StatementTextLine, known: TableHeader | null = null): TableHeader | null => {
    if (line.text.length > HEADER_MAX_LENGTH) return null;
    const cells = rowCells(line, cfg);
    if (cells.length >= cfg.tableHeaderMinRoles) {
      const header = build(cells.map(roleOf), true);
      if (header) return header;
    }
    if (known?.cellMapped) return null;
    // Нэг нүд (эсвэл нүдээр таслагдсан ч таниагдаагүй): синонимыг дарааллаар нь — байрлалаар нь нүдтэй холбохгүй
    const seq = scan(line.text);
    return seq.length >= cfg.tableHeaderMinRoles ? build(seq, false) : null;
  };

  return { roleOf, scan, detectHeader };
}
