// BankProfile + EngineConfig → нэг удаа бэлтгэсэн (regex, синоним) хэрэгсэл. Profile бүрт кэшлэнэ (options өгөөгүй үед).
import { toMatchKey } from '@los/ocr';
import { DEFAULT_HEADER_LABELS, DEFAULT_SKIP_LINE_WORDS, ENGINE_DEFAULTS, type EngineConfig, type EngineOptions } from './defaults';
import type { BankProfile } from './bank-profile';
import { compileColumnMatcher, type ColumnMatcher } from './column-matcher';
import { compileHeaderExtractor, type HeaderExtractor } from './header-block';

export interface CompiledProfile {
  profile: BankProfile;
  cfg: EngineConfig;
  matcher: ColumnMatcher;
  extractor: HeaderExtractor;
  markerKeys: { opening: string[]; closing: string[] };
  /** Хөл/дүнгийн мөрийн угтварууд (toMatchKey) */
  skipKeys: string[];
  /** Банкны нэрийн түлхүүр үгс, давхар таних үгс (toMatchKey) */
  nameKeys: string[];
  rejectKeys: string[];
}

const cache = new WeakMap<BankProfile, CompiledProfile>();

const keysOf = (labels: string[]): string[] => labels.map(toMatchKey).filter((k) => k !== '');

export function compileProfile(profile: BankProfile, options: EngineOptions = {}): CompiledProfile {
  const cacheable = Object.keys(options).length === 0;
  const hit = cacheable ? cache.get(profile) : undefined;
  if (hit) return hit;
  const cfg: EngineConfig = { ...ENGINE_DEFAULTS, ...options };
  const compiled: CompiledProfile = {
    profile,
    cfg,
    matcher: compileColumnMatcher(cfg, profile.columnSynonyms),
    extractor: compileHeaderExtractor(cfg, profile),
    markerKeys: {
      opening: keysOf([...DEFAULT_HEADER_LABELS.openingBalance, ...(profile.headerLabels?.openingBalance ?? [])]),
      closing: keysOf([...DEFAULT_HEADER_LABELS.closingBalance, ...(profile.headerLabels?.closingBalance ?? [])]),
    },
    skipKeys: keysOf([...DEFAULT_SKIP_LINE_WORDS, ...(profile.skipLineKeys ?? [])]),
    nameKeys: [...new Set(keysOf(profile.nameKeywords))],
    rejectKeys: [...new Set(keysOf(profile.rejectKeywords ?? []))],
  };
  if (cacheable) cache.set(profile, compiled);
  return compiled;
}
