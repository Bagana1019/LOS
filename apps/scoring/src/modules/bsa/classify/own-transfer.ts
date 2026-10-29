// BSA-BR-5 / BSA-FR-3.2: харилцагчийн өөрийн данс хоорондын шилжүүлгийг илрүүлж орлого/зарлагаас хасна.
//  (a) ACCOUNT — харьцсан данс харилцагчийн дансны жагсаалтад байна (бүтэн, эсвэл далдалсан '50****4567' сүүлийн цифрээр).
//  (b) PAIR    — ӨӨР хуулгууд дахь эсрэг чиглэлтэй, ижил огноотой, тэнцүү дүнтэй гүйлгээний хос. Хоёулаа цагтай бол минут таарна,
//                харин аль нэг тал Голомт/Хас/Капитрон (цаггүй хуулга) бол цаг шаардахгүй. Гүйлгээ ХАМГИЙН ИХДЭЭ НЭГ хост орно.
//  (c) NAME    — Голомтын хуулгад утганд харилцагчийн бүтэн нэр (үгс дарааллаараа) байвал, бага итгэлтэйгээр.
// Дүн нь минор нэгжээр (бүхэл) харьцуулагдана — float drift-гүй.
import { normalizeAccountNo, parseTime } from '@los/ocr';
import type { ParsedStatement } from '../parsers/statement.types';
import { OWN_TRANSFER_CONFIDENCE, OWN_TRANSFER_DEFAULTS } from './classify.defaults';
import type { ClassifiableTxn, ClassificationContext } from './classify.types';
import { toMinorOrNull } from './money';
import { matchKey } from './normalize';

export type OwnTransferMethod = 'ACCOUNT' | 'PAIR' | 'NAME';

export interface OwnTransferFinding {
  method: OwnTransferMethod;
  /** 0..100 */
  confidence: number;
  /** Аудит/UI-д харуулах тайлбар (PII-гүй) */
  reason: string;
  /** PAIR: хосын нөгөө талын гүйлгээний key */
  pairedKey?: string;
}

export interface OwnTransferOptions {
  timeExemptBanks?: readonly string[];
  nameInDescriptionBanks?: readonly string[];
  minMaskedSuffixDigits?: number;
  minIbanTailDigits?: number;
  maxPairGroupSide?: number;
  maxNameWordGap?: number;
  minNameTokens?: number;
  minNameTokenLength?: number;
}

export interface OwnTransferDetection {
  /** `txns`-тэй индексээр зэрэгцсэн; өөрийн шилжүүлэг биш бол null */
  findings: Array<OwnTransferFinding | null>;
  /** maxPairGroupSide-аар тайрагдсан (хос хайгдаагүй) гүйлгээний тоо — 0 биш бол under-exclusion эрсдэл */
  truncatedPairCandidates: number;
}

type OwnContext = Pick<ClassificationContext, 'ownAccounts' | 'customerNames'>;
type Resolved = Required<OwnTransferOptions>;

const resolve = (o: OwnTransferOptions): Resolved => ({
  timeExemptBanks: o.timeExemptBanks ?? OWN_TRANSFER_DEFAULTS.timeExemptBanks,
  nameInDescriptionBanks: o.nameInDescriptionBanks ?? OWN_TRANSFER_DEFAULTS.nameInDescriptionBanks,
  minMaskedSuffixDigits: o.minMaskedSuffixDigits ?? OWN_TRANSFER_DEFAULTS.minMaskedSuffixDigits,
  minIbanTailDigits: o.minIbanTailDigits ?? OWN_TRANSFER_DEFAULTS.minIbanTailDigits,
  maxPairGroupSide: o.maxPairGroupSide ?? OWN_TRANSFER_DEFAULTS.maxPairGroupSide,
  maxNameWordGap: o.maxNameWordGap ?? OWN_TRANSFER_DEFAULTS.maxNameWordGap,
  minNameTokens: o.minNameTokens ?? OWN_TRANSFER_DEFAULTS.minNameTokens,
  minNameTokenLength: o.minNameTokenLength ?? OWN_TRANSFER_DEFAULTS.minNameTokenLength,
});

const bankOf = (bank: string | null): string => (typeof bank === 'string' ? bank.trim().toUpperCase() : '');
const isIban = (normalized: string): boolean => /^[A-Z]/.test(normalized);

// ───────────────────────── (a) Дансны тулгалт ─────────────────────────

/** Нормчилсон өөрийн дансууд (давхардалгүй, хоосонгүй) */
export function normalizeOwnAccounts(accounts: readonly string[]): string[] {
  return [...new Set(accounts.map((a) => normalizeAccountNo(a)).filter((a) => a !== ''))];
}

/** IBAN-ы сүүлийн цифр = дотоодын данс гэсэн таамаг (MN: 4 банк + 12 данс) — TODO(samples): бодит хуулгаар баталгаажуулна */
function accountsEqual(candidate: string, own: string, minTail: number): boolean {
  if (candidate === own) return true;
  const candidateIban = isIban(candidate);
  const ownIban = isIban(own);
  if (candidateIban && !ownIban) return own.length >= minTail && candidate.endsWith(own);
  if (!candidateIban && ownIban) return candidate.length >= minTail && own.endsWith(candidate);
  return false;
}

const MASKED_ACCOUNT = /^(.*?)[*•●#xX]+(\d+)$/;

/** '5011****4567' / '****4567' / 'XXXXXX4567' → { prefix: '5011', suffix: '4567' }; далдалсан биш бол null */
function parseMaskedAccount(raw: string): { prefix: string; suffix: string } | null {
  if (raw.length > 64) return null;
  const m = MASKED_ACCOUNT.exec(raw.replace(/[\s\-.]/g, ''));
  return m ? { prefix: m[1], suffix: m[2] } : null;
}

/** Харьцсан дансыг өөрийн дансны жагсаалттай тулгана. 'EXACT' бүтэн, 'MASKED' далдалсан дансны сүүлийн цифрээр */
export function matchOwnAccount(raw: string | null, ownNormalized: readonly string[], opts: OwnTransferOptions = {}): 'EXACT' | 'MASKED' | null {
  if (typeof raw !== 'string' || raw.trim() === '' || ownNormalized.length === 0) return null;
  const o = resolve(opts);
  const normalized = normalizeAccountNo(raw);
  if (normalized !== '' && !/[*•●#xX]/.test(raw) && ownNormalized.some((own) => accountsEqual(normalized, own, o.minIbanTailDigits))) return 'EXACT';
  const masked = parseMaskedAccount(raw);
  if (!masked || masked.suffix.length < o.minMaskedSuffixDigits) return null;
  const prefixIsDigits = /^\d+$/.test(masked.prefix);
  const hit = ownNormalized.some(
    (own) => own.endsWith(masked.suffix) && (!prefixIsDigits || isIban(own) || own.startsWith(masked.prefix)),
  );
  return hit ? 'MASKED' : null;
}

// ───────────────────────── (b) Хос тааруулалт ─────────────────────────

const UNKNOWN_TIME_DISTANCE = 24 * 60;

interface PairEdge {
  a: number;
  b: number;
  distance: number;
  verified: boolean;
}

function minuteOf(time: string | null): number | null {
  if (typeof time !== 'string') return null;
  const t = parseTime(time);
  return t === null ? null : Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

function detectPairs(
  txns: readonly ClassifiableTxn[],
  eligible: readonly boolean[],
  o: Resolved,
): { pairs: PairEdge[]; truncated: number } {
  const exempt = new Set(o.timeExemptBanks.map((b) => b.trim().toUpperCase()));
  const groups = new Map<string, { income: number[]; expense: number[] }>();
  txns.forEach((t, i) => {
    const minor = eligible[i] ? toMinorOrNull(t.amount) : null;
    if (minor === null || minor <= 0) return; // тэг, сөрөг, NaN, хэт том дүн хос үүсгэхгүй
    const key = `${t.txnDate}|${minor}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { income: [], expense: [] }));
    (t.direction === 'INCOME' ? g.income : g.expense).push(i);
  });

  const minutes = new Map<number, number | null>();
  const minute = (i: number): number | null => {
    if (!minutes.has(i)) minutes.set(i, minuteOf(txns[i].txnTime));
    return minutes.get(i) as number | null;
  };

  const pairs: PairEdge[] = [];
  let truncated = 0;
  for (const group of groups.values()) {
    if (group.income.length === 0 || group.expense.length === 0) continue;
    truncated += Math.max(0, group.income.length - o.maxPairGroupSide) + Math.max(0, group.expense.length - o.maxPairGroupSide);
    const incomes = group.income.slice(0, o.maxPairGroupSide);
    const expenses = group.expense.slice(0, o.maxPairGroupSide);
    const edges: PairEdge[] = [];
    for (const a of incomes) {
      for (const b of expenses) {
        if (txns[a].statementKey === txns[b].statementKey) continue; // нэг хуулга доторх хос биш (өөр данс хоорондын л шилжүүлэг)
        const ma = minute(a);
        const mb = minute(b);
        if (ma === null || mb === null) edges.push({ a, b, distance: UNKNOWN_TIME_DISTANCE, verified: false });
        else if (ma === mb) edges.push({ a, b, distance: 0, verified: true });
        else if (exempt.has(bankOf(txns[a].bank)) || exempt.has(bankOf(txns[b].bank))) {
          edges.push({ a, b, distance: Math.abs(ma - mb), verified: false });
        }
      }
    }
    // Хамгийн ойр цаг → оролтын эрэмбэ (эрт гүйлгээний индекс түрүүлж) — тодорхой (deterministic) хомхой хослол
    edges.sort((x, y) => x.distance - y.distance || Math.min(x.a, x.b) - Math.min(y.a, y.b) || Math.max(x.a, x.b) - Math.max(y.a, y.b));
    const used = new Set<number>();
    for (const e of edges) {
      if (used.has(e.a) || used.has(e.b)) continue;
      used.add(e.a);
      used.add(e.b);
      pairs.push(e);
    }
  }
  return { pairs, truncated };
}

// ───────────────────────── (c) Голомт: утганд нэр ─────────────────────────

/** Нэрийг үгийн түлхүүрүүд (эхний үсэг хасагдсан) болгож, эрэмбэ/урвуу эрэмбэтэй хоёр хувилбар гаргана */
function nameNeedles(names: readonly string[], o: Resolved): string[][] {
  const needles = new Map<string, string[]>();
  for (const name of names) {
    const tokens = matchKey(name)
      .split(' ')
      .filter((t) => t.length >= o.minNameTokenLength);
    if (tokens.length < o.minNameTokens) continue;
    for (const variant of [tokens, [...tokens].reverse()]) needles.set(variant.join(' '), variant);
  }
  return [...needles.values()];
}

/** `needle`-ийн үгс `words` дотор дарааллаараа, хоорондоо ≤ maxGap завсар үгтэйгээр байна уу */
function containsOrderedTokens(words: readonly string[], needle: readonly string[], maxGap: number): boolean {
  for (let start = 0; start < words.length; start++) {
    if (words[start] !== needle[0]) continue;
    let pos = start;
    let ok = true;
    for (let k = 1; k < needle.length && ok; k++) {
      let found = -1;
      for (let j = pos + 1; j <= pos + 1 + maxGap && j < words.length; j++) {
        if (words[j] === needle[k]) {
          found = j;
          break;
        }
      }
      if (found < 0) ok = false;
      else pos = found;
    }
    if (ok) return true;
  }
  return false;
}

// ───────────────────────── Нэгтгэсэн илрүүлэлт ─────────────────────────

/**
 * Өөрийн данс хоорондын шилжүүлгийг илрүүлнэ. `manualCategoryCode`-той гүйлгээ (хэрэглэгчийн шийдвэр) оролцохгүй.
 * Нэг гүйлгээнд ACCOUNT > PAIR > NAME дарааллаар нэг л илрүүлэлт. Хосын нөгөө тал (ACCOUNT-аар илэрсэн ч) өөрийн PAIR-аа авна.
 */
export function detectOwnTransfers(txns: readonly ClassifiableTxn[], ctx: OwnContext, opts: OwnTransferOptions = {}): OwnTransferDetection {
  const o = resolve(opts);
  const own = normalizeOwnAccounts(ctx.ownAccounts ?? []);
  const findings: Array<OwnTransferFinding | null> = txns.map(() => null);
  const eligible = txns.map((t) => !t.manualCategoryCode);

  // (a) харьцсан данс
  txns.forEach((t, i) => {
    if (!eligible[i]) return;
    const hit = matchOwnAccount(t.counterpartyAccount, own, o);
    if (hit === 'EXACT') {
      findings[i] = { method: 'ACCOUNT', confidence: OWN_TRANSFER_CONFIDENCE.ACCOUNT_EXACT, reason: 'Өөрийн данс: харьцсан данс харилцагчийн дансны жагсаалтад байна (BSA-BR-5)' };
    } else if (hit === 'MASKED') {
      findings[i] = {
        method: 'ACCOUNT',
        confidence: OWN_TRANSFER_CONFIDENCE.ACCOUNT_MASKED,
        reason: 'Өөрийн данс: далдалсан харьцсан дансны сүүлийн цифр харилцагчийн данстай таарсан (BSA-BR-5)',
      };
    }
  });

  // (b) хос
  const { pairs, truncated } = detectPairs(txns, eligible, o);
  for (const p of pairs) {
    const confidence = p.verified ? OWN_TRANSFER_CONFIDENCE.PAIR_TIME_VERIFIED : OWN_TRANSFER_CONFIDENCE.PAIR_TIME_UNVERIFIED;
    const reason = p.verified
      ? 'Өөрийн данс хоорондын шилжүүлэг: өөр хуулгад огноо, дүн, цаг минут таарсан эсрэг гүйлгээ байна (BSA-BR-5)'
      : 'Өөрийн данс хоорондын шилжүүлэг: өөр хуулгад огноо, дүн таарсан эсрэг гүйлгээ байна; цаг шалгагдаагүй (BSA-BR-5)';
    for (const [self, other] of [[p.a, p.b], [p.b, p.a]] as const) {
      const existing = findings[self];
      findings[self] = existing
        ? { ...existing, pairedKey: txns[other].key }
        : { method: 'PAIR', confidence, reason, pairedKey: txns[other].key };
    }
  }

  // (c) Голомт: утганд харилцагчийн нэр
  const nameBanks = new Set(o.nameInDescriptionBanks.map((b) => b.trim().toUpperCase()));
  const needles = nameBanks.size > 0 ? nameNeedles(ctx.customerNames ?? [], o) : [];
  if (needles.length > 0) {
    txns.forEach((t, i) => {
      if (!eligible[i] || findings[i] || !nameBanks.has(bankOf(t.bank))) return;
      const fields = [matchKey(t.description), matchKey(t.counterpartyName)].map((k) => k.split(' '));
      if (needles.some((needle) => fields.some((words) => containsOrderedTokens(words, needle, o.maxNameWordGap)))) {
        findings[i] = {
          method: 'NAME',
          confidence: OWN_TRANSFER_CONFIDENCE.NAME_IN_DESCRIPTION,
          reason: 'Өөрийн данс (бага итгэл): Голомтын хуулгын утганд харилцагчийн бүтэн нэр байна (BSA-BR-5)',
        };
      }
    });
  }
  return { findings, truncatedPairCandidates: truncated };
}

// ───────────────────────── Хуулгаас дансыг авах ─────────────────────────

export type StatementAccountSource = Pick<ParsedStatement, 'bank' | 'accountNo' | 'iban' | 'holderName'>;

/** Харилцагчийн дансны жагсаалтад (source = STATEMENT) автоматаар нэмэх данс. accountNo/iban нь нормчилсон. */
export interface CollectedAccount {
  bank: string;
  accountNo: string | null;
  iban: string | null;
  holderName: string | null;
}

/**
 * BSA-BR-5: хуулгаас уншсан дансны дугаар/IBAN-ыг харилцагчийн дансны жагсаалтад автоматаар нэмэхэд зориулж цуглуулна.
 * Нэг данс хэд хэдэн хуулганд (accountNo-той, IBAN-тай) гарвал нэгтгэнэ. Дугаар/IBAN аль нь ч байхгүй хуулгыг алгасна.
 * Дуудагч нь зөвхөн verifier-ээр нэр/регистр нь баталгаажсан хуулгыг өгөх ёстой (өөр хүний данс жагсаалтад орохгүйн тулд).
 */
export function collectAccountsFromStatements(statements: readonly StatementAccountSource[]): CollectedAccount[] {
  const out: CollectedAccount[] = [];
  for (const s of statements) {
    const rawAccount = s.accountNo ? normalizeAccountNo(s.accountNo) : '';
    const rawIban = s.iban ? normalizeAccountNo(s.iban) : '';
    // accountNo-д IBAN өгсөн ч, iban-д дотоодын дугаар өгсөн ч зөв талбарт нь оруулна
    const ibanLike = [rawIban, rawAccount].find((v) => v !== '' && isIban(v)) ?? '';
    const accountLike = [rawAccount, rawIban].find((v) => v !== '' && !isIban(v)) ?? '';
    if (ibanLike === '' && accountLike === '') continue;
    const existing = out.find(
      (e) =>
        (accountLike !== '' && e.accountNo === accountLike) ||
        (ibanLike !== '' && e.iban === ibanLike) ||
        (ibanLike !== '' && e.accountNo !== null && accountsEqual(ibanLike, e.accountNo, OWN_TRANSFER_DEFAULTS.minIbanTailDigits)) ||
        (accountLike !== '' && e.iban !== null && accountsEqual(e.iban, accountLike, OWN_TRANSFER_DEFAULTS.minIbanTailDigits)),
    );
    if (existing) {
      existing.accountNo ??= accountLike || null;
      existing.iban ??= ibanLike || null;
      existing.holderName ??= s.holderName ?? null;
    } else {
      out.push({ bank: s.bank, accountNo: accountLike || null, iban: ibanLike || null, holderName: s.holderName ?? null });
    }
  }
  return out;
}

/** CollectedAccount[] → ClassificationContext.ownAccounts-д нэмэх дансны тэмдэгт мөрүүд (нормчилсон, давхардалгүй) */
export function ownAccountKeys(accounts: readonly CollectedAccount[]): string[] {
  return normalizeOwnAccounts(accounts.flatMap((a) => [a.accountNo ?? '', a.iban ?? '']));
}
