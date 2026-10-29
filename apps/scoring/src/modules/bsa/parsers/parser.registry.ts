// Хуулгын parser-уудын бүртгэл: банк таних (detect), тодорхойгүй/дэмжигдээгүй тохиолдол, гараар сонгосон банкаар parse. BSA-FR-2.1, NFR-5.
// Шинэ банк = шинэ <bank>.parser.ts + banks/index.ts-ийн BANK_PARSERS-д нэг мөр; энд өөрчлөлт хэрэггүй.
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { BankCode } from '@los/contracts';
import { DEFAULT_BANK_POLICY } from './bank-policy';
import type { BankPolicy, ParsedStatement, StatementParser, StatementText } from './statement.types';

/** Multi-provider токен: `StatementParser[]` (parsers.module.ts дахь factory-оор угсарна) */
export const PARSERS = Symbol('PARSERS');
export const PARSER_REGISTRY_OPTIONS = Symbol('PARSER_REGISTRY_OPTIONS');

/**
 * Банк таних анхдагч — НЭГ газар (бизнесийн босго биш, таних техникийн параметр; PARSER_REGISTRY_OPTIONS-оор дарж болно).
 * minScore нь engine-ийн ENGINE_DEFAULTS.detect-тэй уялдана: банкны нэргүй (noKeywordMax 0.4) < minScore < гарчиг + хүснэгтийн толгой (0.7).
 */
export const REGISTRY_DEFAULTS = {
  minScore: 0.5,
  /** Хоёр өөр банкны оноо энэ зөрүүнд багтвал тодорхойгүй */
  ambiguityMargin: 0.05,
} as const;

export interface ParserRegistryOptions {
  minScore: number;
  ambiguityMargin: number;
}

export interface BankCandidate {
  bank: BankCode;
  parserId: string;
  /** 0..1 */
  score: number;
}

export interface BankDetection {
  parser: StatementParser;
  score: number;
  /** Бүх банкны оноо, өндрөөс нь */
  candidates: BankCandidate[];
}

const summarize = (candidates: BankCandidate[]): string =>
  candidates.length === 0 ? 'no parsers' : candidates.map((c) => `${c.bank}=${c.score.toFixed(2)}`).join(', ');

/** Банк танигдсангүй / parser бүртгэгдээгүй. Мессежид зөвхөн банкны код, оноо (PII-гүй). */
export class UnsupportedBankError extends Error {
  readonly code = 'UNSUPPORTED_BANK';
  constructor(readonly candidates: BankCandidate[], reason = 'statement bank was not recognised') {
    super(`${reason} (${summarize(candidates)})`);
    this.name = 'UnsupportedBankError';
  }
}

/** Хоёр ба түүнээс олон банк ойролцоо оноотой — хэрэглэгч банкаа гараар сонгоно. */
export class AmbiguousBankError extends Error {
  readonly code = 'AMBIGUOUS_BANK';
  constructor(readonly candidates: BankCandidate[]) {
    super(`statement matches several banks (${summarize(candidates)})`);
    this.name = 'AmbiguousBankError';
  }
}

@Injectable()
export class StatementParserRegistry {
  private readonly options: ParserRegistryOptions;

  constructor(
    @Inject(PARSERS) private readonly parsers: StatementParser[],
    @Optional() @Inject(PARSER_REGISTRY_OPTIONS) options?: Partial<ParserRegistryOptions>,
  ) {
    this.options = { ...REGISTRY_DEFAULTS, ...(options ?? {}) };
  }

  /** Бүртгэлтэй банкууд (давхардалгүй) */
  banks(): BankCode[] {
    return [...new Set(this.parsers.map((p) => p.bank))];
  }

  /** Нэг банкны parser (олон бол эхнийх). Үгүй бол UnsupportedBankError. */
  get(bank: BankCode): StatementParser {
    const found = this.parsers.find((p) => p.bank === bank);
    if (!found) throw new UnsupportedBankError([], `no parser registered for ${bank}`);
    return found;
  }

  /** Банкны бодлого (зураг хүлээн авах, IBAN хэлбэр); parser.policy байхгүй бол DEFAULT_BANK_POLICY. Бүртгэлгүй банкинд DEFAULT. */
  policyFor(bank: BankCode): BankPolicy {
    return this.parsers.find((p) => p.bank === bank)?.policy ?? DEFAULT_BANK_POLICY;
  }

  /** Банк бүрийн хамгийн өндөр оноо (өндрөөс нь). Хэзээ ч throw хийхгүй — UI "аль банк вэ?" гэж асуухад. */
  candidates(text: StatementText): BankCandidate[] {
    const best = new Map<BankCode, BankCandidate>();
    for (const p of this.parsers) {
      let score = 0;
      try {
        score = clamp01(p.detect(text));
      } catch {
        score = 0; // parser-ийн алдаа бусдыг бүү унагаа
      }
      const prev = best.get(p.bank);
      if (!prev || score > prev.score) best.set(p.bank, { bank: p.bank, parserId: p.id, score });
    }
    return [...best.values()].sort((a, b) => b.score - a.score || a.bank.localeCompare(b.bank));
  }

  /** Хамгийн сайн parser (≥ minScore). Хоёр банк margin дотор → AmbiguousBankError, байхгүй → UnsupportedBankError. */
  detect(text: StatementText): BankDetection {
    const candidates = this.candidates(text);
    const top = candidates[0];
    if (!top || top.score < this.options.minScore) throw new UnsupportedBankError(candidates);
    const close = candidates.filter((c) => top.score - c.score <= this.options.ambiguityMargin + 1e-9 && c.score >= this.options.minScore);
    if (close.length > 1) throw new AmbiguousBankError(close);
    return { parser: this.parserFor(top), score: top.score, candidates };
  }

  /**
   * Parse. bank өгөөгүй бол detect(); өгвөл тухайн банкны parser-ээр (хэрэглэгч гараар сонгосон). Гараар сонгосон ч detect()
   * босгоос доогуур бол ParseWarning BANK_OVERRIDE_UNCONFIRMED нэмнэ — verifier/UI-д "банк таарсангүй" гэж үзүүлэх.
   */
  parse(text: StatementText, bank?: BankCode): ParsedStatement {
    if (bank === undefined) return this.detect(text).parser.parse(text);
    const parser = this.get(bank);
    const parsed = parser.parse(text);
    const score = this.candidates(text).find((c) => c.bank === bank)?.score ?? 0;
    if (score < this.options.minScore) {
      parsed.warnings.push({ code: 'BANK_OVERRIDE_UNCONFIRMED', message: `bank was chosen manually; detection score ${score.toFixed(2)}` });
    }
    return parsed;
  }

  private parserFor(c: BankCandidate): StatementParser {
    return this.parsers.find((p) => p.id === c.parserId && p.bank === c.bank) ?? this.get(c.bank);
  }
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
