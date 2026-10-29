// Хуулгын толгой хэсгийн талбарууд: данс, IBAN, эзэмшигч, хугацаа, валют, эхний/эцсийн үлдэгдэл, нийт мөрийн тоо (BSA-FR-2.2).
// Утга нь шошготой ижил нүдэнд ':'-ын дараа, дараагийн нүдэнд, эсвэл дараагийн мөрөнд байж болно. Монгол + Англи шошго.
import { findDates, normalizeAccountNo, parseMnAmount, parseRegisterNo, type DateOrder } from '@los/ocr';
import { HEADER_FIELDS, type BankProfile, type HeaderField } from './bank-profile';
import { DEFAULT_HEADER_LABELS, type EngineConfig } from './defaults';
import { PARSE_WARNING, type WarningCollector } from './warnings';

export interface HeaderFields {
  accountNo: string | null;
  iban: string | null;
  holderName: string | null;
  registerNo: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  currency: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  declaredRowCount: number | null;
}

export const emptyHeaderFields = (): HeaderFields => ({
  accountNo: null,
  iban: null,
  holderName: null,
  registerNo: null,
  periodFrom: null,
  periodTo: null,
  currency: null,
  openingBalance: null,
  closingBalance: null,
  declaredRowCount: null,
});

/** Хүснэгтийн дараах (хөл) мөрөөс зөвхөн эдгээрийг авна — өөрийг нь авбал гүйлгээний утгын wrap-тай андуурна */
const FOOTER_FIELDS: ReadonlySet<HeaderField> = new Set(['openingBalance', 'closingBalance', 'declaredRowCount']);

export interface ZoneLine {
  cells: string[];
  page: number;
  line: number;
}

export interface HeaderExtractor {
  /** Толгой хэсгийн мөрүүд (хүснэгтийн толгойноос өмнөх) → бүх талбар */
  extractZone(lines: ZoneLine[], warnings: WarningCollector): HeaderFields;
  /**
   * Хүснэгтийн дундах/сүүлийн нэг мөр → зөвхөн opening/closing/count (байвал). matched=true: мөр хөлийн шошготой (утга уншигдсан ч үгүй) →
   * гүйлгээний утгын үргэлжлэл биш.
   */
  extractFooterLine(line: ZoneLine, warnings: WarningCollector, next?: () => string[] | undefined): { matched: boolean; fields: HeaderFields };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** Нэг үгтэй богино шошго ('Нэр', 'To', 'Данс') нь ':' эсвэл нүдний хил/хоёр зайны дараа л шошго болно */
const isLoose = (label: string): boolean => label === 'IBAN' || /\s/.test(label) || label.length >= 10;
const IBAN_IN_TEXT_RE = /(?<![A-Za-z0-9])MN\d{2}(?: ?\d{4}){4}(?!\d)/;
const IBAN_VALUE_RE = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{2,4}){3,8}(?![A-Za-z0-9])/;
const REGISTER_IN_TEXT_RE = /(?<![\p{L}\d])[\p{L}]{2}[ -]?\d{8}(?!\d)/u;
const AMOUNT_HEAD_RE = /^[+-]?\(?\d[\d., ']*\)?-?/;

interface Hit {
  field: HeaderField;
  index: number;
  length: number;
}

interface Pair {
  field: HeaderField;
  value: string;
}

export function compileHeaderExtractor(cfg: EngineConfig, profile: Pick<BankProfile, 'headerLabels' | 'dateOrder'>): HeaderExtractor {
  const labelField = new Map<string, HeaderField>();
  const labels: Array<{ label: string; field: HeaderField }> = [];
  for (const field of HEADER_FIELDS) {
    for (const label of [...DEFAULT_HEADER_LABELS[field], ...(profile.headerLabels?.[field] ?? [])]) {
      const norm = label.toLowerCase().replace(/\s+/g, ' ');
      if (labelField.has(norm)) continue;
      labelField.set(norm, field);
      labels.push({ label, field });
    }
  }
  labels.sort((a, b) => b.label.length - a.label.length);
  const buildRe = (only?: ReadonlySet<HeaderField>): RegExp => {
    const alternatives = labels
      .filter(({ field }) => !only || only.has(field))
      .map(({ label }) =>
        escapeRe(label).replace(/\s+/g, '\\s+') + (isLoose(label) ? '(?:\\s*[:\\uFF1A]|(?=\\s|$))' : '(?:\\s*[:\\uFF1A]|(?=\\t|\\s{2,}|$))'),
      );
    return new RegExp(`(?<=^|\\t|\\s{2}|[|;]\\s?)(?:${alternatives.join('|')})`, 'giu');
  };
  const labelRe = buildRe();
  const footerRe = buildRe(FOOTER_FIELDS); // хүснэгтийн мөр бүр дээр ажиллана → зөвхөн хөлийн шошго (цөөн хувилбар)
  const order: DateOrder = profile.dateOrder;

  const hitsOf = (joined: string, re: RegExp = labelRe): Hit[] => {
    const out: Hit[] = [];
    for (const m of joined.matchAll(re)) {
      const norm = m[0].replace(/\s*[:\uFF1A]$/, '').toLowerCase().replace(/\s+/g, ' ').trim();
      const field = labelField.get(norm);
      if (field) out.push({ field, index: m.index as number, length: m[0].length });
    }
    return out;
  };

  /** Нэг мөрөөс (шошго, утга) хосууд. next = дараагийн мөр (утга доор байх тохиолдол). allowed = зөвхөн эдгээр талбар */
  const pairsOf = (cells: string[], next: string[] | undefined, allowed?: ReadonlySet<HeaderField>): Pair[] => {
    const joined = cells.join('\t').slice(0, cfg.maxLineLength);
    const hits = hitsOf(joined, allowed ? footerRe : labelRe);
    if (hits.length === 0) return [];
    const hitAt = new Set(hits.map((h) => h.index));
    const pairs: Pair[] = [];
    let emptyCount = 0;
    hits.forEach((hit, i) => {
      let start = hit.index + hit.length;
      while (joined[start] === ' ' || joined[start] === '\u00A0') start++;
      const nextHit = hits[i + 1]?.index ?? joined.length;
      const tab = joined.indexOf('\t', start);
      let value = joined.slice(start, Math.min(nextHit, tab < 0 ? joined.length : tab)).trim();
      if (value === '' && tab >= 0 && tab < nextHit && !hitAt.has(tab + 1) && tab + 1 < joined.length) {
        const tab2 = joined.indexOf('\t', tab + 1);
        value = joined.slice(tab + 1, tab2 < 0 ? joined.length : tab2).trim(); // дараагийн нүд
      }
      if (value === '') emptyCount++;
      pairs.push({ field: hit.field, value });
    });
    if (next && emptyCount === pairs.length) {
      if (pairs.length === 1 && next.length >= 1 && hitsOf(next.join('\t')).length === 0) {
        pairs[0].value = next[0].trim(); // утга дараагийн мөрөнд
      } else if (pairs.length > 1 && next.length === cells.length && cells.length === pairs.length) {
        pairs.forEach((p, k) => (p.value = next[k].trim())); // "шошгоны мөр" + "утгын мөр"
      }
    }
    return pairs.filter((p) => p.value !== '' && (!allowed || allowed.has(p.field)));
  };

  const firstAmount = (value: string): number | null => {
    const head = AMOUNT_HEAD_RE.exec(value)?.[0].trim();
    if (!head) return null;
    return parseMnAmount(head) ?? parseMnAmount(head.split(' ')[0]);
  };

  const cleanName = (value: string): string | null => {
    const name = value
      .replace(REGISTER_IN_TEXT_RE, '')
      .replace(/[()[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, cfg.maxHeaderValueLength);
    return /\p{L}{2}/u.test(name) && !/^\d+$/.test(name) ? name : null;
  };

  /** Нэг (шошго, утга) хосыг талбарт буулгана; танигдсан бол true */
  const apply = (target: HeaderFields, pair: Pair, where: ZoneLine, warnings: WarningCollector, strictFirst: boolean): void => {
    const { field, value } = pair;
    const set = <K extends keyof HeaderFields>(key: K, v: HeaderFields[K]): void => {
      if (v === null) return;
      const current = target[key];
      if (current === null) target[key] = v;
      else if (strictFirst && current !== v) {
        warnings.add(PARSE_WARNING.HEADER_FIELD_CONFLICT, `Header field "${key}" printed with different values; first one kept`, where.page, where.line);
      }
    };
    const invalid = (): void => {
      warnings.add(PARSE_WARNING.HEADER_FIELD_INVALID, `Header field "${field}" value could not be read`, where.page, where.line);
    };
    switch (field) {
      case 'accountNo': {
        const iban = IBAN_IN_TEXT_RE.exec(value.toUpperCase());
        if (iban) set('iban', normalizeAccountNo(iban[0]));
        const digits = /\d[\d -]{4,28}\d/.exec(iban ? value.toUpperCase().replace(iban[0], ' ') : value)?.[0];
        const account = digits ? normalizeAccountNo(digits) : '';
        if (account.length >= 6 && account.length <= 20) set('accountNo', account);
        else if (!iban) invalid();
        break;
      }
      case 'iban': {
        const iban = IBAN_VALUE_RE.exec(value.toUpperCase())?.[0] ?? IBAN_IN_TEXT_RE.exec(value.toUpperCase())?.[0];
        if (iban) set('iban', normalizeAccountNo(iban));
        else invalid();
        break;
      }
      case 'holderName': {
        const reg = REGISTER_IN_TEXT_RE.exec(value)?.[0];
        if (reg) {
          const r = parseRegisterNo(reg);
          if (r.valid) set('registerNo', r.value);
        }
        set('holderName', cleanName(value));
        break;
      }
      case 'registerNo': {
        const r = parseRegisterNo(REGISTER_IN_TEXT_RE.exec(value)?.[0] ?? value);
        if (r.valid) set('registerNo', r.value);
        else invalid();
        break;
      }
      case 'periodRange': {
        const dates = findDates(value, { order });
        if (dates.length >= 2) {
          const isos = dates.map((d) => d.iso).sort();
          set('periodFrom', isos[0]);
          set('periodTo', isos[isos.length - 1]);
        }
        break;
      }
      case 'periodFrom':
      case 'periodTo': {
        const d = findDates(value, { order })[0];
        if (d) set(field, d.iso);
        else invalid();
        break;
      }
      case 'currency': {
        const code = /(?<![A-Za-z])[A-Z]{3}(?![A-Za-z])/.exec(value.toUpperCase())?.[0];
        if (code) set('currency', code);
        else if (/₮|төг|tug/i.test(value)) set('currency', 'MNT');
        break;
      }
      case 'openingBalance':
      case 'closingBalance': {
        const n = firstAmount(value);
        if (n === null) invalid();
        else set(field, n);
        break;
      }
      case 'declaredRowCount': {
        const m = /^(\d{1,7})(?!\d|[.,]\d)/.exec(value);
        if (m) set('declaredRowCount', Number(m[1]));
        break; // "Нийт гүйлгээ: 1,200,000.00" (дүн) бол мөрийн тоо биш → чимээгүй алгасна
      }
    }
  };

  const extractZone = (lines: ZoneLine[], warnings: WarningCollector): HeaderFields => {
    const out = emptyHeaderFields();
    lines.forEach((l, i) => {
      for (const pair of pairsOf(l.cells, lines[i + 1]?.cells)) apply(out, pair, l, warnings, true);
    });
    if (out.iban === null) {
      for (const l of lines) {
        const m = IBAN_IN_TEXT_RE.exec(l.cells.join(' ').toUpperCase());
        if (m) {
          out.iban = normalizeAccountNo(m[0]);
          break;
        }
      }
    }
    return out;
  };

  const extractFooterLine = (
    line: ZoneLine,
    warnings: WarningCollector,
    next?: () => string[] | undefined,
  ): { matched: boolean; fields: HeaderFields } => {
    const out = emptyHeaderFields();
    const joined = line.cells.join('\t').slice(0, cfg.maxLineLength);
    const matched = hitsOf(joined, footerRe).length > 0;
    if (matched) for (const pair of pairsOf(line.cells, next?.(), FOOTER_FIELDS)) apply(out, pair, line, warnings, false);
    return { matched, fields: out };
  };

  return { extractZone, extractFooterLine };
}
