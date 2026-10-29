import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  GoodsCategory, MerchantErrorCode, MerchantRole, MerchantStatus, POS_POLICY_DEFAULTS, PosDecision, PosLeaseAction, PosLeaseStatus, PosPublicReason, PosReasonCode, PosReasonSeverity,
} from '@los/contracts';
import { describe, expect, it } from 'vitest';
import mnMerchant from '@los/ui/src/i18n/mn.merchant.json';
import { hasMessage, messageKeys, t } from './i18n';

// Каталог нь бүх модулийн түлхүүртэй нэгдсэн (mn.ts) — энэ тест зөвхөн МЕРЧАНТ каталогийн (mn.merchant.json) чанарыг шалгана; бусад модуль өөрийнхөө тестийг хөтөлнө.
const merchantKeys = Object.keys(mnMerchant);

// i18n бүрэн байдал: контрактын enum бүрт текст байх ёстой, кодод ашигласан түлхүүр бүр байх ёстой. Түлхүүр дутвал энэ тест УНАНА.

/** Дутсан түлхүүрүүдийг буцаана (хоосон = бүрэн). Тест дэх "unit under test" нь өөрөө шалгагддаг. */
export function missingKeys(required: readonly string[]): string[] {
  return required.filter((k) => !hasMessage(k));
}

const family = (prefix: string, values: readonly string[]): string[] => values.map((v) => `${prefix}.${v}`);

describe('missingKeys helper (the completeness check really fails on a missing key)', () => {
  it('reports every key that is absent', () => {
    expect(missingKeys(['pos.status.DRAFT', 'pos.status.NOT_A_STATUS', 'nope'])).toEqual(['pos.status.NOT_A_STATUS', 'nope']);
    expect(missingKeys([])).toEqual([]);
  });
  it('would flag a new contract enum value that has no translation', () => {
    const future = [...PosLeaseStatus, 'ON_HOLD'] as string[];
    expect(missingKeys(family('pos.status', future))).toEqual(['pos.status.ON_HOLD']);
  });
  it('t() returns the key itself for a missing key instead of an empty string', () => {
    expect(t('does.not.exist')).toBe('does.not.exist');
    expect(hasMessage('does.not.exist')).toBe(false);
  });
});

describe('contract enums have Mongolian text', () => {
  const cases: Array<[string, string[]]> = [
    ['pos.status', family('pos.status', PosLeaseStatus)],
    ['pos.announce (aria-live)', family('pos.announce', PosLeaseStatus)],
    ['pos.action', family('pos.action', PosLeaseAction)],
    ['pos.public reason', family('pos.public', PosPublicReason)],
    ['pos.reason (internal)', family('pos.reason', PosReasonCode)],
    ['pos.severity', family('pos.severity', PosReasonSeverity)],
    ['pos.decision', family('pos.decision', PosDecision)],
    ['pos.decidedBy', family('pos.decidedBy', ['SYSTEM', 'REVIEWER'])],
    ['pos.actor', family('pos.actor', ['SYSTEM', 'BUYER', 'MERCHANT', 'LENDER', 'UNKNOWN'])],
    ['pos.timeline', family('pos.timeline', ['CREATED', 'CONSENT_VERIFIED', 'SUBMITTED', 'DECIDED', 'REVIEWED', 'ACCEPTED', 'DELIVERED', 'SETTLED', 'CANCELLED', 'EXPIRED', 'REQUOTED', 'UNKNOWN'])],
    ['merchant.status', family('merchant.status', MerchantStatus)],
    ['merchant.role', family('merchant.role', MerchantRole)],
    ['goodsCategory', family('goodsCategory', GoodsCategory)],
    ['plans.policy (every PosPolicy key)', family('plans.policy', Object.keys(POS_POLICY_DEFAULTS))],
    ['error (every MerchantErrorCode + client-side codes)', family('error', [...MerchantErrorCode, 'INTERNAL', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'UNKNOWN'])],
    ['guided flow steps', ['decision', 'goods', 'buyer', 'consent', 'accept', 'deliver'].map((s) => `pos.step.${s}`)],
  ];
  it.each(cases)('%s', (_name, keys) => {
    expect(missingKeys(keys)).toEqual([]);
  });

  it('error variants carry the placeholders their callers pass', () => {
    const expected: Record<string, string> = {
      'error.DOWN_PAYMENT_TOO_LOW.withMin': 'min', 'error.AMOUNT_OUT_OF_RANGE.withRange': 'min', 'error.TICKET_LIMIT_EXCEEDED.withMax': 'max', 'error.DAILY_LIMIT_EXCEEDED.withLimit': 'limit',
      'error.TERM_NOT_ALLOWED.withAllowed': 'terms', 'error.OTP_INVALID.withLeft': 'left', 'error.OTP_RESEND_TOO_SOON.withWait': 'seconds',
    };
    for (const [key, param] of Object.entries(expected)) {
      expect(hasMessage(key), key).toBe(true);
      expect(t(key), key).toContain(`{${param}}`);
    }
  });
});

describe('message catalogue quality', () => {
  const keys = merchantKeys;
  it('is not empty and has no blank values', () => {
    expect(keys.length).toBeGreaterThan(400);
    for (const k of keys) expect(t(k).trim().length, k).toBeGreaterThan(0);
  });
  it('UI text is Mongolian Cyrillic (only the brand name is Latin)', () => {
    const latinOnlyAllowed = new Set(['merchant.brand']);
    for (const k of keys) {
      if (latinOnlyAllowed.has(k)) continue;
      const words = t(k).replace(/\{\w+\}/g, '');
      // Зөвхөн placeholder/тэмдэгтээс бүрдсэн (жишээ: "{used} / {limit}") мөрийг алгасна.
      if (!/\p{L}/u.test(words)) continue;
      expect(/[А-Яа-яӨөҮүЁё]/.test(words), `${k}: ${t(k)}`).toBe(true);
    }
  });
  it('placeholders are simple {word} tokens and balanced', () => {
    for (const k of keys) {
      const text = t(k);
      expect((text.match(/\{/g) ?? []).length, k).toBe((text.match(/\}/g) ?? []).length);
      for (const m of text.matchAll(/\{([^}]*)\}/g)) expect(m[1], `${k}: ${text}`).toMatch(/^\w+$/);
    }
  });
  it('t() substitutes params and leaves unknown placeholders untouched', () => {
    expect(t('quote.perMonth', { term: 12 })).toBe('12 сарын турш');
    expect(t('panel.approved.expiresIn', {})).toContain('{time}');
    expect(t('quote.perMonth', { term: 'a', extra: 'b' })).toBe('a сарын турш');
  });
});

// ───────────── Эх кодод ашигласан түлхүүр бүр орчуулгатай эсэх ─────────────
const SRC = join(__dirname, '..');
const SCAN_DIRS = ['features/merchant', 'app/merchant', 'app/settings/merchants', 'app/los/pos-leases', 'lib'];
const NAMESPACES = ['merchant', 'format', 'dashboard', 'leases', 'newLease', 'quote', 'panel', 'otp', 'cancel', 'detail', 'pos', 'goodsCategory', 'validation', 'error', 'merchants', 'stores', 'plans', 'admin', 'backoffice'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Эх кодын текстээс орчуулгын түлхүүрүүдийг (literal ба template-ийн угтвар) гаргана. */
export function extractKeys(text: string): { literals: string[]; prefixes: string[] } {
  const nsPattern = NAMESPACES.join('|');
  const literal = new RegExp(`['"](((?:${nsPattern})\\.)[A-Za-z0-9_.]*[A-Za-z0-9_])['"]`, 'g');
  const templatePrefix = new RegExp(`\`((?:${nsPattern})\\.[A-Za-z0-9_.]*)\\$\\{`, 'g');
  return { literals: [...text.matchAll(literal)].map((m) => m[1]!), prefixes: [...text.matchAll(templatePrefix)].map((m) => m[1]!) };
}

describe('source scanner', () => {
  it('finds literal keys and dynamic prefixes, and the missing one is reported', () => {
    const sample = "const a = t('merchant.cta.newLease'); const b = t(\"merchant.not.a.key\"); const c = t(`pos.status.${s}`); const d = 'merchant';";
    const { literals, prefixes } = extractKeys(sample);
    expect(literals).toEqual(['merchant.cta.newLease', 'merchant.not.a.key']);
    expect(prefixes).toEqual(['pos.status.']);
    expect(missingKeys(literals)).toEqual(['merchant.not.a.key']);
  });
});

describe('every translation key used in source exists', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(join(SRC, d)));
  const used = new Map<string, string>();
  const prefixes = new Map<string, string>();
  for (const f of files) {
    const { literals, prefixes: pre } = extractKeys(readFileSync(f, 'utf8'));
    for (const k of literals) if (!used.has(k)) used.set(k, relative(SRC, f));
    for (const p of pre) if (!prefixes.has(p)) prefixes.set(p, relative(SRC, f));
  }

  it('scans a meaningful amount of source', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(used.size).toBeGreaterThan(100);
  });
  it('literal keys', () => {
    const missing = [...used.entries()].filter(([k]) => !hasMessage(k)).map(([k, file]) => `${k}  (${file})`);
    expect(missing).toEqual([]);
  });
  it('dynamic key families (template literals) have at least one translation', () => {
    const empty = [...prefixes.entries()].filter(([p]) => !messageKeys().some((k) => k.startsWith(p))).map(([p, file]) => `${p}\${...}  (${file})`);
    expect(empty).toEqual([]);
  });
  it('every namespace in the catalogue is referenced somewhere in code', () => {
    const referencedNamespaces = new Set([...used.keys(), ...prefixes.keys()].map((k) => k.split('.')[0]));
    const catalogueNamespaces = new Set(merchantKeys.map((k) => k.split('.')[0]));
    for (const ns of catalogueNamespaces) expect(referencedNamespaces.has(ns), `namespace ${ns} is never used in code`).toBe(true);
  });
});
