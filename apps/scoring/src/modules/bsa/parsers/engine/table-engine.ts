// BSA-FR-2.1/2.2, NFR-5: НЭГ тохируулгатай хүснэгт хуулгын engine. Банк бүрийн ялгаа BankProfile өгөгдөлд (banks/*.parser.ts).
// Урсгал: мөр бүрийг уншиж (толгой хэсэг → хүснэгтийн толгой → гүйлгээний мөр, wrap, дүн/хөл алгасах) → хронологи дараалал →
// чиглэлийн санал хураалт → ParsedStatement. Эргэлзээтэй шийдвэр бүр ParseWarning үлдээнэ; гүйлгээний мөрийг чимээгүй хаяхгүй.
import { normalizeWhitespace, toMatchKey } from '@los/ocr';
import type { TxnDirection } from '@los/contracts';
import type { ParsedStatement, ParsedTransaction, StatementText } from '../statement.types';
import type { BankProfile } from './bank-profile';
import type { TableHeader } from './column-matcher';
import { compileProfile } from './compiled-profile';
import type { CompiledProfile } from './compiled-profile';
import { detectReversed, flipHint, impliedDirection, voteSwap } from './direction';
import type { EngineOptions } from './defaults';
import { emptyHeaderFields, type HeaderFields, type ZoneLine } from './header-block';
import { parseRowLine, type RawRow, type RowContext } from './row-parser';
import { endsWithAmountPair, findAccountInText, rowCells } from './text-utils';
import { PARSE_WARNING, WarningCollector } from './warnings';

const BARE_PAGE_NUMBER_RE = /^[-–—\s]*\d{1,4}[-–—\s]*$/;
const PAGE_FRACTION_RE = /^\d{1,4}\s*\/\s*\d{1,4}$/;

const opposite = (d: TxnDirection): TxnDirection => (d === 'INCOME' ? 'EXPENSE' : 'INCOME');
const sameLayout = (a: TableHeader, b: TableHeader): boolean => a.roles.join('|') === b.roles.join('|');
const firstNonNull = <T>(...values: Array<T | null>): T | null => values.find((v) => v !== null) ?? null;

/** Хуудасны дугаар, дүн/нийлбэр, хэвлэсэн огноо зэрэг гүйлгээ биш богино мөр */
function isSkipLine(text: string, c: CompiledProfile): boolean {
  const t = text.trim();
  if (t.length > c.cfg.maxSkipLineLength) return false;
  if (BARE_PAGE_NUMBER_RE.test(t) || PAGE_FRACTION_RE.test(t)) return true;
  const key = toMatchKey(t.slice(0, 40));
  return c.skipKeys.some((k) => key === k || key.startsWith(`${k} `));
}

export function parseTableStatement(text: StatementText, profile: BankProfile, options: EngineOptions = {}): ParsedStatement {
  const c = compileProfile(profile, options);
  const { cfg } = c;
  const warnings = new WarningCollector(cfg.maxWarningsPerCode);
  const debitDir: TxnDirection = profile.debitMeans ?? 'EXPENSE';
  const ctx: RowContext = {
    cfg,
    order: profile.dateOrder,
    header: null,
    debitDir,
    creditDir: opposite(debitDir),
    spaceThousands: profile.spaceThousands === true,
    markerKeys: c.markerKeys,
  };

  let tableStarted = false;
  let fields: HeaderFields = emptyHeaderFields();
  const footer = emptyHeaderFields();
  const markers: { opening: number | null; closing: number | null } = { opening: null, closing: null };
  const zoneLines: ZoneLine[] = [];
  const pendingUnparsed: Array<{ page: number; line: number; reason: string }> = [];
  const rows: RawRow[] = [];
  let current: RawRow | null = null;
  let canContinue = false;
  let continuation = 0;
  let fallbackRows = 0;
  let firstFallback: { page: number; line: number } | null = null;

  const unparsed = (page: number, line: number, reason: string): void => {
    warnings.add(PARSE_WARNING.UNPARSED_ROW, `Row looks like a transaction but could not be read: ${reason}`, page, line);
  };
  const startTable = (header: TableHeader | null): void => {
    tableStarted = true;
    ctx.header = header;
    const zone = header ? zoneLines : zoneLines.slice(0, cfg.headerZoneFallbackLines);
    fields = c.extractor.extractZone(zone, warnings);
    if (!header) warnings.add(PARSE_WARNING.TABLE_HEADER_NOT_FOUND, 'Table header not found; columns read from the right (balance last)');
    // Хүснэгтийн толгойгүйгээр эхэлсэн бол түүнээс өмнөх мөр шиг мөрүүд жинхэнэ мөр байсан байж болно; толгой олдсон бол энэ нь толгой хэсгийн мөр
    if (!header) for (const p of pendingUnparsed) unparsed(p.page, p.line, p.reason);
  };

  for (const page of text.pages) {
    current = null;
    canContinue = false;
    continuation = 0;
    page.lines.forEach((line, idx) => {
      const lineNo = idx + 1;
      if (line.text.trim() === '' && line.cells.every((cell) => cell.trim() === '')) return;
      const cells = rowCells(line, cfg);
      const res = parseRowLine(cells, page.pageNo, lineNo, ctx);

      if (res.kind === 'row') {
        if (!tableStarted) startTable(null);
        rows.push(res.row);
        current = res.row;
        canContinue = true;
        continuation = 0;
        if (res.row.viaFallback && ctx.header) {
          fallbackRows++;
          firstFallback = firstFallback ?? { page: page.pageNo, line: lineNo };
        }
        return;
      }
      if (res.kind === 'marker') {
        if (!tableStarted) startTable(null);
        if (res.which === 'opening') markers.opening = markers.opening ?? res.balance;
        else markers.closing = res.balance;
        current = null;
        canContinue = false;
        return;
      }
      if (res.kind === 'unparsed') {
        if (tableStarted) unparsed(page.pageNo, lineNo, res.reason);
        else pendingUnparsed.push({ page: page.pageNo, line: lineNo, reason: res.reason });
        current = null;
        canContinue = false;
        return;
      }

      // Дараахь нь гүйлгээний мөр биш: 'none' (огноогоор эхлээгүй) эсвэл 'dateOnly' (огноотой ч дүнгүй)
      if (res.kind === 'none') {
        const header = c.matcher.detectHeader(line, ctx.header);
        if (header) {
          if (tableStarted && ctx.header && !sameLayout(ctx.header, header)) {
            warnings.add(PARSE_WARNING.TABLE_HEADER_CHANGED, 'Table header layout changed between pages', page.pageNo, lineNo);
          }
          if (tableStarted) ctx.header = header;
          else startTable(header);
          current = null;
          canContinue = false;
          return;
        }
      }
      if (!tableStarted) {
        if (zoneLines.length < cfg.headerZoneMaxLines) zoneLines.push({ cells, page: page.pageNo, line: lineNo });
        return;
      }
      const zl: ZoneLine = { cells, page: page.pageNo, line: lineNo };
      const nextLine = page.lines[idx + 1];
      const foot = c.extractor.extractFooterLine(zl, warnings, () => (nextLine ? rowCells(nextLine, cfg) : undefined));
      if (foot.matched) {
        for (const key of ['openingBalance', 'closingBalance', 'declaredRowCount'] as const) {
          if (footer[key] === null) footer[key] = foot.fields[key];
        }
        canContinue = false;
        return;
      }
      if (res.kind === 'none' && isSkipLine(line.text, c)) {
        canContinue = false;
        return;
      }
      if (endsWithAmountPair(line.text)) {
        unparsed(page.pageNo, lineNo, 'line ends with amounts but does not start with a date');
        canContinue = false;
        return;
      }
      if (current && canContinue) {
        if (continuation < cfg.maxContinuationLines) {
          current.descParts.push(normalizeWhitespace(line.text));
          continuation++;
          if (res.kind === 'dateOnly') warnings.add(PARSE_WARNING.DATE_ONLY_LINE_MERGED, 'Line starting with a date but without amounts merged into previous row', page.pageNo, lineNo);
        } else {
          warnings.add(PARSE_WARNING.CONTINUATION_DROPPED, 'Too many continuation lines; line ignored', page.pageNo, lineNo);
        }
      }
    });
  }

  if (!tableStarted) {
    // Гүйлгээний мөр, хүснэгтийн толгой олдсонгүй — толгой хэсгээс аль болох авна
    fields = c.extractor.extractZone(zoneLines.slice(0, cfg.headerZoneFallbackLines), warnings);
    warnings.add(PARSE_WARNING.TABLE_HEADER_NOT_FOUND, 'Neither a table header nor transaction rows were found');
  }

  const openingBalance = firstNonNull(fields.openingBalance, footer.openingBalance, markers.opening);
  const closingBalance = firstNonNull(fields.closingBalance, footer.closingBalance, markers.closing);
  const declaredRowCount = firstNonNull(fields.declaredRowCount, footer.declaredRowCount);

  // ---- Хронологи дараалал ----
  if (rows.length >= 2) {
    const order = detectReversed(rows, cfg.balanceEpsilon);
    if (order.reversed) {
      rows.reverse();
      warnings.add(PARSE_WARNING.REVERSED_ORDER, `Statement is newest-first (detected by ${order.basis}); rows reversed to chronological order`);
    }
  }

  // ---- Чиглэл ----
  const signedColumn = rows.some((r) => r.signedNegative);
  for (const r of rows) if (r.weakPositive) r.hint = signedColumn ? 'INCOME' : null;
  const vote = voteSwap(rows, openingBalance, cfg.balanceEpsilon, cfg.directionVoteMinRows);
  if (vote.swap) {
    rows.forEach(flipHint);
    warnings.add(PARSE_WARNING.DIRECTION_SWAPPED, `Debit/credit columns contradict balance changes (${vote.disagree} of ${vote.agree + vote.disagree}); directions swapped`);
  }

  const transactions: ParsedTransaction[] = [];
  let fromBalance = 0;
  rows.forEach((row, i) => {
    let direction = row.hint;
    if (!direction) {
      direction = impliedDirection(i === 0 ? openingBalance : rows[i - 1].balance, row.balance, row.amount, cfg.balanceEpsilon);
      if (direction) fromBalance++;
    }
    if (!direction) {
      unparsed(row.page, row.line, 'direction could not be determined (no sign, no usable balance change)');
      return;
    }
    const description = normalizeWhitespace(row.descParts.join(' '));
    transactions.push({
      seq: transactions.length + 1,
      txnDate: row.date,
      txnTime: row.time,
      direction,
      amount: row.amount,
      balanceAfter: row.balance,
      description,
      counterpartyAccount: row.counterpartyAccount ?? findAccountInText(description, cfg),
      counterpartyName: row.counterpartyName,
      sourcePage: row.page,
      sourceLine: row.line,
    });
  });
  if (fromBalance > 0) {
    warnings.add(PARSE_WARNING.DIRECTION_FROM_BALANCE, `${fromBalance} of ${rows.length} rows: direction taken from the balance change (no usable sign/column)`);
  }
  if (fallbackRows > 0 && firstFallback) {
    const at: { page: number; line: number } = firstFallback;
    warnings.add(PARSE_WARNING.ROW_FALLBACK_LAYOUT, `${fallbackRows} of ${rows.length} rows did not match the table columns; read from the right`, at.page, at.line);
  }

  // ---- Хугацаа, валют, цаг ----
  let periodFrom = fields.periodFrom;
  let periodTo = fields.periodTo;
  if ((periodFrom === null || periodTo === null) && transactions.length > 0) {
    periodFrom = periodFrom ?? transactions[0].txnDate;
    periodTo = periodTo ?? transactions[transactions.length - 1].txnDate;
    warnings.add(PARSE_WARNING.PERIOD_DERIVED, 'Statement period is not printed; taken from the first/last transaction dates');
  }
  if (fields.currency === null) warnings.add(PARSE_WARNING.CURRENCY_ASSUMED, `Currency is not printed; assumed ${cfg.defaultCurrency}`);
  if (transactions.length > 0) {
    if (profile.hasTime && transactions.every((t) => t.txnTime === null)) {
      warnings.add(PARSE_WARNING.TIME_MISSING, 'Profile expects a time of day but no row has one');
    } else if (!profile.hasTime && transactions.some((t) => t.txnTime !== null)) {
      warnings.add(PARSE_WARNING.TIME_UNEXPECTED, 'Profile assumes no time of day but some rows have one; kept');
    }
  }

  return {
    bank: profile.bank,
    parserId: profile.parserId,
    parserVerified: profile.verified,
    accountNo: fields.accountNo,
    iban: fields.iban,
    holderName: fields.holderName,
    holderRegisterNo: fields.registerNo,
    currency: fields.currency ?? cfg.defaultCurrency,
    periodFrom,
    periodTo,
    openingBalance,
    closingBalance,
    declaredRowCount,
    transactions,
    unparsedRowCount: warnings.count(PARSE_WARNING.UNPARSED_ROW),
    warnings: warnings.finish(),
  };
}
