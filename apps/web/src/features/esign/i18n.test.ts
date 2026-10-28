import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ESignProvider, SigningFailureReason, SigningStatus } from '@los/contracts';
import { mn } from '@los/ui';
import esignMn from '@los/ui/src/i18n/esign.mn.json';
import mnJson from '@los/ui/src/i18n/mn.json';
import { describe, expect, it } from 'vitest';
import { t, type MnKey } from './i18n';

const SRC = resolve(__dirname, '../..');
const SOURCE_DIRS = ['features/esign', 'features/contract-signing', 'app/sign', 'app/verify'].map((d) => join(SRC, d));
const PREFIX = /^(esign|verify|contractSigning)\./;

function sourceFiles(): string[] {
  return SOURCE_DIRS.flatMap((dir) =>
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes('testing'))
      .map((f) => join(dir, f)),
  );
}

/** Эх кодод бичигдсэн бүх `'esign.…'` / `"verify.…"` / `` `contractSigning.…` `` литерал */
function referencedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of sourceFiles()) {
    for (const match of readFileSync(file, 'utf8').matchAll(/['"`]((?:esign|verify|contractSigning)\.[A-Za-z0-9_.]+)['"`]/g)) keys.add(match[1]);
  }
  return keys;
}

const dictionaryKeys = Object.keys(mn);

describe('i18n: esign.* / verify.* / contractSigning.*', () => {
  it('эх кодод ашигласан түлхүүр бүр толь бичигт байна', () => {
    const referenced = referencedKeys();
    expect(referenced.size).toBeGreaterThan(100);
    const missing = [...referenced].filter((key) => !Object.hasOwn(mn, key));
    expect(missing).toEqual([]);
  });

  it('толь бичгийн esign/verify/contractSigning түлхүүр бүр ашиглагдаж байна (үхсэн түлхүүргүй)', () => {
    const referenced = referencedKeys();
    const unused = Object.keys(esignMn).filter((key) => !referenced.has(key));
    expect(unused).toEqual([]);
  });

  it('mn = mn.json + esign.mn.json: түлхүүр давхцахгүй, анхны түлхүүрүүд хэвээр', () => {
    const overlap = Object.keys(mnJson).filter((key) => Object.hasOwn(esignMn, key));
    expect(overlap).toEqual([]);
    expect(dictionaryKeys.sort()).toEqual([...Object.keys(mnJson), ...Object.keys(esignMn)].sort());
    for (const [key, value] of Object.entries(mnJson)) expect(mn[key as keyof typeof mn], key).toBe(value);
  });

  it('esign.mn.json зөвхөн зөвшөөрөгдсөн угтвартай түлхүүртэй', () => {
    const stray = Object.keys(esignMn).filter((key) => !PREFIX.test(key));
    expect(stray).toEqual([]);
  });

  it('утга бүр хоосон биш; монгол кирилл (зөвхөн нэр/тушаал нь үл хамаарна)', () => {
    const technical = new Set(['esign.provider.TRIDUM', 'esign.provider.MONPASS', 'verify.howTo.windows', 'verify.howTo.windowsCmd', 'verify.howTo.unix', 'verify.howTo.unixCmd']);
    for (const [key, value] of Object.entries(esignMn)) {
      expect(value.trim(), key).not.toBe('');
      expect(value, key).toBe(value.trim());
      if (!technical.has(key)) expect(value, key).toMatch(/[А-Яа-яӨөҮүЁё]/);
    }
  });

  it('enum бүрт текст бий: төлөв, шалтгаан, үйлчилгээ', () => {
    for (const status of SigningStatus) expect(mn, status).toHaveProperty(`contractSigning.status.${status}`);
    expect(mn).toHaveProperty('contractSigning.status.NONE');
    for (const reason of SigningFailureReason) {
      expect(mn, reason).toHaveProperty(`esign.failed.${reason}`);
      expect(mn, reason).toHaveProperty(`contractSigning.failure.${reason}`);
    }
    for (const provider of ESignProvider) expect(mn, provider).toHaveProperty(`esign.provider.${provider}`);
  });

  it('шаардлагад заасан үндсэн текстүүд', () => {
    const expected: Array<[MnKey, string]> = [
      ['esign.review.openFull', 'Гэрээг бүтнээр нээх'],
      ['esign.review.continue', 'Үргэлжлүүлэх'],
      ['esign.waiting.codeLabel', 'Утсан дээрх код ийм байх ёстой'],
      ['esign.waiting.openApp', 'Апп-аа нээх'],
      ['esign.waiting.cancel', 'Болих'],
      ['esign.signed.download', 'Гарын үсэгтэй гэрээг татах'],
      ['esign.failed.IDENTITY_MISMATCH', 'Таны регистр гарын үсгийн гэрчилгээтэй таарсангүй, салбартай холбогдоно уу'],
      ['verify.notFound.title', 'Баталгаажуулах код олдсонгүй'],
      ['verify.mockBadge', 'ТЕСТ ХҮЧИНГҮЙ'],
      ['esign.provider.mockTag', 'ТЕСТ'],
      ['contractSigning.send', 'Тоон гарын үсгээр илгээх'],
      ['contractSigning.resend', 'Дахин илгээх'],
      ['contractSigning.cancel', 'Цуцлах'],
    ];
    for (const [key, text] of expected) expect(mn[key], key).toBe(text);
  });

  it('зөвшөөрлийн текст: хууль зүйн хүчинтэй + гэрээг уншсан гэдгийг хоёуланг нь агуулна', () => {
    expect(mn['esign.choose.consent']).toContain('гэрээг бүрэн уншиж');
    expect(mn['esign.choose.consent']).toContain('хууль зүйн хүчинтэй');
  });
});

describe('t()', () => {
  it('{name} placeholder-ийг орлуулна', () => {
    expect(t('esign.waiting.codeHelp', { provider: 'Tridum' })).toBe('Tridum апп дээр харагдаж буй код дээрх кодтой ижил бол зөвшөөрнө үү.');
  });
  it('өгөөгүй placeholder-ийг хэвээр үлдээнэ, prototype-ийн нэрийг орлуулахгүй', () => {
    expect(t('esign.waiting.codeHelp')).toContain('{provider}');
    expect(t('esign.waiting.codeHelp', {})).toContain('{provider}');
    expect(t('esign.waiting.codeHelp', { constructor: 'x' })).toContain('{provider}');
  });
  it('placeholder-тай түлхүүр бүр t()-д хэрэгтэй хувьсагчийг мэддэг', () => {
    const withVars = Object.entries(esignMn).filter(([, v]) => /\{\w+\}/.test(v));
    expect(withVars.map(([k]) => k).sort()).toEqual(['esign.signed.copyUntil', 'esign.waiting.codeHelp', 'esign.waiting.openAppHint']);
  });
});
