// BSA-FR-3.1 / 3.5: ангиллын дүрмийн сангаас гүйлгээнд таарах дүрмийг сонгох.
//  - Чиглэл тус бүрийн дүрмийг priority ↓, source (ADMIN → FEEDBACK), хэв/хэллэгийн урт ↓ дарааллаар эрэмбэлж нэг удаа compile хийнэ.
//  - Эхэнд таарсан дүрэм ялна ("хамгийн тодорхой нь ялна").
//  - KEYWORD: toMatchKey(утга) + toMatchKey(харьцсан нэр) дээр ҮГИЙН ХИЛ хүндэтгэсэн дэд мөр (text-match.ts).
//  - COUNTERPARTY: нормчилсон дансны дугаар ЭСВЭЛ нормчилсон нэр яг тэнцэх.
//  - REGEX: regex-guard.ts-ийн аюулгүй compile; анхны текст болон түлхүүр хоёр дээр шалгана.
import type { TxnDirection } from '@los/contracts';
import { normalizeAccountNo } from '@los/ocr';
import { CLASSIFY_CONFIDENCE, MATCHING_DEFAULTS } from './classify.defaults';
import type { BsaCategoryDef, BsaRuleDef } from './classify.types';
import { matchKey, rawTextOf, type PreparedTxn } from './normalize';
import { compileSafeRegex, testSafeRegex, type RegexRejectCode } from './regex-guard';
import { lastWordLength, matchPhrase } from './text-match';

export type RuleIssueCode =
  | RegexRejectCode
  | 'INVALID_RULE'
  | 'EMPTY_PATTERN'
  | 'UNKNOWN_CATEGORY'
  | 'CATEGORY_INACTIVE'
  | 'DIRECTION_MISMATCH';

/** Таслагдсан дүрмийн тайлан. PII-гүй: дүрмийн индекс/id, шалтгаан л байна (pattern-ийг давтахгүй). */
export interface RuleIssue {
  index: number;
  ruleId: string | null;
  code: RuleIssueCode;
  message: string;
}

type Matcher =
  | { kind: 'KEYWORD'; phrase: string; prefixAllowed: boolean }
  | { kind: 'COUNTERPARTY_ACCOUNT'; account: string }
  | { kind: 'COUNTERPARTY_NAME'; nameKey: string }
  | { kind: 'REGEX'; regex: RegExp };

export interface CompiledRule {
  rule: BsaRuleDef;
  /** Оролтын жагсаалтын индекс (эцсийн тодорхой эрэмбэд) */
  index: number;
  matcher: Matcher;
  /** Эрэмбийн "тодорхой байдал": хэллэг/данс/нэрийн урт, REGEX-д эх хэвийн урт */
  specificity: number;
}

export interface RuleSet {
  byDirection: Record<TxnDirection, CompiledRule[]>;
  issues: RuleIssue[];
}

export interface RuleMatch {
  rule: BsaRuleDef;
  matchType: BsaRuleDef['matchType'];
  /** 0..100 (CLASSIFY_CONFIDENCE) */
  confidence: number;
  /** KEYWORD: хоёр захаараа бүтэн үг/хэллэг таарсан */
  wholePhrase: boolean;
}

const SOURCE_RANK: Record<BsaRuleDef['source'], number> = { ADMIN: 0, FEEDBACK: 1 };
const TYPE_RANK: Record<Matcher['kind'], number> = { COUNTERPARTY_ACCOUNT: 0, COUNTERPARTY_NAME: 0, KEYWORD: 1, REGEX: 2 };

/** COUNTERPARTY хэвийг данс уу, нэр үү гэж ялгана: зөвхөн цифр (≥ 6) эсвэл IBAN хэлбэртэй бол данс */
type CounterpartyMatcher = Extract<Matcher, { kind: 'COUNTERPARTY_ACCOUNT' | 'COUNTERPARTY_NAME' }>;

function counterpartyMatcher(pattern: string): CounterpartyMatcher | null {
  const account = normalizeAccountNo(pattern);
  const letters = pattern.replace(/[^\p{L}]/gu, '');
  const isDigits = /^\d{6,}$/.test(account) && letters === '';
  const isIban = /^[A-Z]{2}\d{2}/.test(account) && account.length >= 15 && letters.length <= 6;
  if (isDigits || isIban) return { kind: 'COUNTERPARTY_ACCOUNT', account };
  const nameKey = matchKey(pattern);
  return nameKey === '' ? null : { kind: 'COUNTERPARTY_NAME', nameKey };
}

function compileMatcher(rule: BsaRuleDef): { matcher: Matcher; specificity: number } | RuleIssue['code'] | { code: RegexRejectCode; reason: string } {
  if (rule.matchType === 'KEYWORD') {
    const phrase = matchKey(rule.pattern);
    if (phrase === '') return 'EMPTY_PATTERN';
    return {
      matcher: { kind: 'KEYWORD', phrase, prefixAllowed: lastWordLength(phrase) >= MATCHING_DEFAULTS.minPrefixWordLength },
      specificity: phrase.length,
    };
  }
  if (rule.matchType === 'COUNTERPARTY') {
    const matcher = counterpartyMatcher(rule.pattern);
    if (!matcher) return 'EMPTY_PATTERN';
    return { matcher, specificity: matcher.kind === 'COUNTERPARTY_ACCOUNT' ? matcher.account.length : matcher.nameKey.length };
  }
  if (rule.matchType === 'REGEX') {
    const compiled = compileSafeRegex(rule.pattern);
    if (!compiled.ok) return { code: compiled.code, reason: compiled.reason };
    return { matcher: { kind: 'REGEX', regex: compiled.regex }, specificity: rule.pattern.length };
  }
  return 'INVALID_RULE';
}

/**
 * Дүрмийн санг нэг удаа compile + эрэмбэлнэ. Буруу дүрэм (хоосон хэв, аюултай/буруу regex, үл мэдэгдэх/идэвхгүй ангилал,
 * ангиллын чиглэлтэй зөрсөн) ТАСЛАГДАЖ `issues`-д бүртгэгдэнэ — бусад дүрэм хэвийн ажиллана (admin нэг буруу дүрмээр импортыг унагахгүй).
 */
export function compileRuleSet(rules: readonly BsaRuleDef[], categories: readonly BsaCategoryDef[]): RuleSet {
  const byCode = new Map(categories.map((c) => [c.code, c]));
  const byDirection: RuleSet['byDirection'] = { INCOME: [], EXPENSE: [] };
  const issues: RuleIssue[] = [];
  rules.forEach((rule, index) => {
    const issue = (code: RuleIssueCode, message: string): void => {
      issues.push({ index, ruleId: rule.id ?? null, code, message });
    };
    if (!rule || typeof rule.pattern !== 'string' || !Object.hasOwn(byDirection, rule.direction) || !Number.isFinite(rule.priority)) {
      return issue('INVALID_RULE', 'rule has an invalid direction, pattern or priority');
    }
    const category = byCode.get(rule.categoryCode);
    if (!category) return issue('UNKNOWN_CATEGORY', `category "${rule.categoryCode}" does not exist`);
    if (!category.isActive) return issue('CATEGORY_INACTIVE', `category "${rule.categoryCode}" is inactive`);
    if (category.direction !== rule.direction) {
      return issue('DIRECTION_MISMATCH', `rule direction ${rule.direction} differs from category "${rule.categoryCode}" direction`);
    }
    const compiled = compileMatcher(rule);
    if (typeof compiled === 'string') return issue(compiled, compiled === 'EMPTY_PATTERN' ? 'pattern has no matchable text' : 'unsupported match type');
    if ('code' in compiled) return issue(compiled.code, compiled.reason);
    byDirection[rule.direction].push({ rule, index, matcher: compiled.matcher, specificity: compiled.specificity });
  });
  for (const list of Object.values(byDirection)) {
    list.sort(
      (a, b) =>
        b.rule.priority - a.rule.priority ||
        SOURCE_RANK[a.rule.source] - SOURCE_RANK[b.rule.source] ||
        b.specificity - a.specificity ||
        TYPE_RANK[a.matcher.kind] - TYPE_RANK[b.matcher.kind] ||
        a.index - b.index,
    );
  }
  return { byDirection, issues };
}

function confidenceOf(rule: BsaRuleDef, matchType: BsaRuleDef['matchType'], wholePhrase: boolean): number {
  if (rule.source === 'FEEDBACK') return CLASSIFY_CONFIDENCE.FEEDBACK;
  if (matchType === 'COUNTERPARTY') return CLASSIFY_CONFIDENCE.COUNTERPARTY;
  if (matchType === 'REGEX') return CLASSIFY_CONFIDENCE.REGEX;
  return CLASSIFY_CONFIDENCE.KEYWORD + (wholePhrase ? CLASSIFY_CONFIDENCE.KEYWORD_WHOLE_PHRASE_BONUS : 0);
}

/** Гүйлгээнд таарах хамгийн тодорхой дүрэм (байхгүй бол null). O(#дүрэм) хамгийн ихдээ, эхний таарсанд зогсоно. */
export function evaluateRules(p: PreparedTxn, ruleSet: RuleSet): RuleMatch | null {
  for (const compiled of ruleSet.byDirection[p.txn.direction] ?? []) {
    const m = compiled.matcher;
    let whole = false;
    let hit = false;
    switch (m.kind) {
      case 'KEYWORD': {
        const r = matchPhrase(p.haystack, m.phrase, m.prefixAllowed);
        hit = r !== null;
        whole = r === 'EXACT';
        break;
      }
      case 'COUNTERPARTY_ACCOUNT':
        hit = p.account !== '' && p.account === m.account;
        break;
      case 'COUNTERPARTY_NAME':
        hit = p.counterpartyNameKey !== '' && p.counterpartyNameKey === m.nameKey;
        break;
      case 'REGEX':
        // Анхны текст (кирилл хэвээр) дээр, дараа нь түлхүүр (араг яс) дээр: admin аль ч бичлэгээр бичиж болно
        hit = testSafeRegex(m.regex, rawTextOf(p)) || testSafeRegex(m.regex, p.haystack);
        break;
    }
    if (hit) {
      const { rule } = compiled;
      return { rule, matchType: rule.matchType, wholePhrase: whole, confidence: confidenceOf(rule, rule.matchType, whole) };
    }
  }
  return null;
}
