// Хуулгын verifier (BSA-FR-2.2, 2.3): parse-ийн үр дүнг бие даан шалгана — мөрийн тоо, үлдэгдлийн гинж, IBAN, нэр/регистр, огноо,
// давхар мөр, зураг/OCR/QR, PDF metadata. Цэвэр функц (QR-ийн үр дүнг гаднаас авна). Мессежид PII (нэр, данс, утга) бичихгүй.
import { isValidIban, namesMatch, parseRegisterNo } from '@los/ocr';
import { DEFAULT_BANK_POLICY } from '../bank-policy';
import { dedupeKey } from '../coverage';
import type {
  ParsedStatement,
  ParsedTransaction,
  StatementFileMeta,
  VerificationIssue,
  VerificationIssueCode,
  VerificationResult,
} from '../statement.types';
import { checkAuthenticity } from './authenticity';
import { resolveVerifyOptions, type VerifyOptions, type VerifyOptionsInput } from './verify-defaults';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const signed = (t: ParsedTransaction): number => (t.direction === 'INCOME' ? t.amount : -t.amount);
/** Тооцооны хөвөгч цэгийн алдааг (1e-9) хүлж зөрүү хязгаараас хэтэрсэн эсэх */
const differs = (a: number, b: number, tolerance: number): boolean => Math.abs(round2(a) - round2(b)) > tolerance + 1e-9;

/** Зураг (JPG/PNG...) эсвэл QR-тай файл → QR баталгаажуулалт шаардана (BSA-FR-2.1: "QR баталгаатай JPG/PNG") */
export function requiresQr(meta: StatementFileMeta): boolean {
  return meta.mimeType.toLowerCase().startsWith('image/') || (meta.qrPayloads?.length ?? 0) > 0;
}

/**
 * @param qrVerified QR-ийн үр дүн (QrVerifier.verify): true/false/null. undefined = оролдоогүй (null-тай адил).
 *   Зөвхөн requiresQr(meta) үед QR_NOT_VERIFIED issue гарна.
 */
export function verifyStatement(
  parsed: ParsedStatement,
  optionsInput: VerifyOptionsInput,
  meta: StatementFileMeta,
  qrVerified?: boolean | null,
): VerificationResult {
  const options = resolveVerifyOptions(optionsInput);
  const issues: VerificationIssue[] = [];
  const add = (code: VerificationIssueCode, message: string, at: { seq?: number; page?: number; line?: number } = {}, forced?: 'ERROR' | 'WARNING'): void => {
    const configured = options.severity[code];
    if (configured === 'OFF') return;
    // forced: QR татгалзсан гэх мэт кодын анхдагчаас хатуу тохиолдол — гэхдээ 'OFF'/тодорхой тохиргоо давуу
    const severity = forced && optionsInput.severity?.[code] === undefined ? forced : configured;
    issues.push({ code, severity, message, ...at });
  };

  const txns = parsed.transactions;
  const unparsed = parsed.unparsedRowCount ?? parsed.warnings.filter((w) => w.code === 'UNPARSED_ROW').length;

  // ---- Бүтэц: мөр, мөрийн тоо ----
  let structural = true;
  if (txns.length === 0) {
    structural = false;
    add('NO_TRANSACTIONS', 'No transactions were read from the statement');
  }
  if (parsed.declaredRowCount !== null && parsed.declaredRowCount !== txns.length) {
    structural = false;
    add('ROW_COUNT_MISMATCH', `Statement declares ${parsed.declaredRowCount} transactions but ${txns.length} were read`);
  }
  if (unparsed > 0) {
    structural = false;
    add('ROW_COUNT_MISMATCH', `${unparsed} row(s) looked like transactions but could not be read`);
  }

  if (txns.length > 0) {
    checkBalances(parsed, options, add);
    checkDates(parsed, add);
    checkDuplicates(txns, add);
  }

  // ---- Толгой: IBAN, нэр, регистр ----
  if (parsed.iban !== null && !isValidIban(parsed.iban)) {
    add('IBAN_INVALID', 'The IBAN printed on the statement is not valid (structure or checksum)');
  }
  checkHolder(parsed, options, add);

  // ---- Эх файл: банкны бодлого, OCR, PDF metadata, QR ----
  const policy = options.policy ?? DEFAULT_BANK_POLICY;
  if (meta.mimeType.toLowerCase().startsWith('image/') && !policy.acceptsImages) {
    add('IMAGE_NOT_ACCEPTED', `${parsed.bank} does not accept image statements; a PDF is required`);
  }
  if (meta.ocr && meta.ocr.meanConfidence < options.ocrMinConfidence) {
    add('OCR_LOW_CONFIDENCE', `OCR mean confidence ${meta.ocr.meanConfidence.toFixed(2)} is below ${options.ocrMinConfidence}`);
  }
  const authenticity = checkAuthenticity(meta, options);
  for (const i of authenticity.issues) add(i.code, i.message);

  const qr = qrVerified ?? null;
  if (requiresQr(meta)) {
    if (qr === false) add('QR_NOT_VERIFIED', 'The bank rejected the QR code of this statement', {}, 'ERROR');
    else if (qr === null) add('QR_NOT_VERIFIED', 'The QR code could not be verified against the bank (verification is not available)');
  }

  if (!parsed.parserVerified) {
    add('UNVERIFIED_PARSER', `Parser ${parsed.parserId} is not verified against real statements; results need review`);
  }

  return {
    parserOk: structural,
    verifierOk: !issues.some((i) => i.severity === 'ERROR'),
    qrVerified: qr,
    issues,
    authenticity: authenticity.report,
  };
}

type Add = (code: VerificationIssueCode, message: string, at?: { seq?: number; page?: number; line?: number }, forced?: 'ERROR' | 'WARNING') => void;

/** Үлдэгдлийн гинж, эхний/эцсийн үлдэгдэл. Үлдэгдэлгүй мөрүүдийн дундуур ч дүнгээр нь дамжуулж тулгана. */
function checkBalances(parsed: ParsedStatement, options: VerifyOptions, add: Add): void {
  const txns = parsed.transactions;
  const withBalance = txns.filter((t) => t.balanceAfter !== null).length;
  if (withBalance / txns.length < options.minBalanceCoverage) {
    add(
      'BALANCE_UNAVAILABLE',
      withBalance === 0
        ? 'The statement has no balance column; the balance chain cannot be checked'
        : `Only ${withBalance} of ${txns.length} rows have a balance; the balance chain is only partially checked`,
    );
  }
  const tol = options.balanceTolerance;

  // Эхний үлдэгдэл ↔ эхний үлдэгдэлтэй мөр
  const firstIdx = txns.findIndex((t) => t.balanceAfter !== null);
  let running: number | null = null; // сүүлд мэдэгдсэн үлдэгдэл (дүнгээр дамжуулсан)
  let from = 0;
  if (firstIdx >= 0) {
    if (parsed.openingBalance !== null) {
      let expected = parsed.openingBalance;
      for (let i = 0; i <= firstIdx; i++) expected += signed(txns[i]);
      if (differs(expected, txns[firstIdx].balanceAfter as number, tol)) {
        add('OPENING_BALANCE_MISMATCH', 'The opening balance and the first row do not agree', { seq: txns[firstIdx].seq });
      }
    }
    running = txns[firstIdx].balanceAfter;
    from = firstIdx + 1;
  } else if (parsed.openingBalance !== null) {
    running = parsed.openingBalance;
  }

  // Гинж
  const breaks: number[] = [];
  let lastKnown = running;
  for (let i = from; i < txns.length; i++) {
    const t = txns[i];
    if (lastKnown !== null) lastKnown = round2(lastKnown + signed(t));
    if (t.balanceAfter === null) continue;
    if (lastKnown !== null && differs(lastKnown, t.balanceAfter, tol)) breaks.push(t.seq);
    lastKnown = t.balanceAfter;
  }
  const total = breaks.length;
  breaks.slice(0, options.maxListedBreaks).forEach((seq, k) => {
    add('BALANCE_CHAIN_BREAK', `Balance does not follow the previous row (break ${k + 1} of ${total})`, { seq });
  });

  // Эцсийн үлдэгдэл: сүүлийн үлдэгдэлтэй мөр (+ түүнээс хойших дүн); ямар ч мөрөнд үлдэгдэл байхгүй бол opening + Σ дүн
  if (parsed.closingBalance !== null && lastKnown !== null && differs(lastKnown, parsed.closingBalance, tol)) {
    add('CLOSING_BALANCE_MISMATCH', 'The closing balance and the last row do not agree', { seq: txns[txns.length - 1].seq });
  }
}

/** Огнооны дараалал, хугацааны тохироо */
function checkDates(parsed: ParsedStatement, add: Add): void {
  const txns = parsed.transactions;
  let disorder = 0;
  let firstDisorder = 0;
  for (let i = 1; i < txns.length; i++) {
    const a = txns[i - 1];
    const b = txns[i];
    const earlier = b.txnDate < a.txnDate || (b.txnDate === a.txnDate && a.txnTime !== null && b.txnTime !== null && b.txnTime < a.txnTime);
    if (earlier) {
      disorder++;
      if (firstDisorder === 0) firstDisorder = b.seq;
    }
  }
  if (disorder > 0) add('DATE_ORDER', `${disorder} row(s) are dated earlier than the previous row (first at row ${firstDisorder})`, { seq: firstDisorder });

  const { periodFrom, periodTo } = parsed;
  if (periodFrom !== null && periodTo !== null && periodFrom > periodTo) {
    add('PERIOD_MISMATCH', 'The statement period start is after its end');
    return;
  }
  let outside = 0;
  let firstOutside = 0;
  for (const t of txns) {
    if ((periodFrom !== null && t.txnDate < periodFrom) || (periodTo !== null && t.txnDate > periodTo)) {
      outside++;
      if (firstOutside === 0) firstOutside = t.seq;
    }
  }
  if (outside > 0) add('PERIOD_MISMATCH', `${outside} row(s) fall outside the statement period (first at row ${firstOutside})`, { seq: firstOutside });
}

/** Яг ижил мөр (огноо, цаг, дүн, чиглэл, үлдэгдэл, утга) — давхар оруулсан эсвэл жинхэнэ давтагдсан төлбөр */
function checkDuplicates(txns: ParsedTransaction[], add: Add): void {
  const seen = new Map<string, number>();
  let duplicates = 0;
  let firstDuplicate = 0;
  for (const t of txns) {
    const key = dedupeKey(t);
    if (seen.has(key)) {
      duplicates++;
      if (firstDuplicate === 0) firstDuplicate = t.seq;
    } else seen.set(key, t.seq);
  }
  if (duplicates > 0) {
    add('DUPLICATE_ROWS', `${duplicates} row(s) repeat an earlier row exactly (first at row ${firstDuplicate}); they may be legitimate repeated payments`, {
      seq: firstDuplicate,
    });
  }
}

/** Эзэмшигчийн нэр, регистр ↔ харилцагч (хуулганд хэвлэгдсэн үед л) */
function checkHolder(parsed: ParsedStatement, options: VerifyOptions, add: Add): void {
  const customer = options.customer;
  if (!customer) return;
  const names = customer.names.filter((n) => n.trim() !== '');
  if (parsed.holderName !== null && names.length > 0) {
    const holder = parsed.holderName;
    const ok = names.some((n) => namesMatch(holder, n, options.nameMinScore === undefined ? {} : { minScore: options.nameMinScore }).match);
    if (!ok) add('NAME_MISMATCH', 'The account holder name on the statement does not match the customer');
  }
  const printed = parsed.holderRegisterNo ?? null;
  if (printed !== null && customer.registerNo) {
    const a = parseRegisterNo(printed);
    const b = parseRegisterNo(customer.registerNo);
    if (a.valid && b.valid && a.value !== b.value) add('REGISTER_MISMATCH', 'The register number on the statement does not match the customer');
  }
}
