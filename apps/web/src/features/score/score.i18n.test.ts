import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AutoSelectReason, CalcMethod, ReasonCode, ReasonStep, SCORING_ERROR_CODES, SOSCO_COMPONENTS, SoscoGrade } from '@los/contracts';
import mnScore from '../../../../../packages/ui/src/i18n/mn.score.json';
import { mn } from '@los/ui';
import { ERROR_KEYS } from './score.utils';

const dict = mnScore as Record<string, string>;
const has = (key: string) => key in dict;

describe('score.* i18n', () => {
  it('түлхүүр бүр `score.` угтвартай, бусад модулийн каталогтой давхцахгүй', () => {
    for (const key of Object.keys(dict)) {
      expect(key.startsWith('score.'), key).toBe(true);
      expect(mn[key], key).toBe(dict[key]);
    }
  });

  it('утга бүр монгол кирилл (нэр томьёо/нэгжээс бусад)', () => {
    const allowedLatin = new Set(['score.sosco.scale', 'score.stress.title', 'score.compare.row.stress', 'score.policy.ltv']);
    for (const [key, value] of Object.entries(dict)) {
      expect(value.trim(), key).not.toBe('');
      if (!allowedLatin.has(key)) expect(/[А-Яа-яӨөҮүЁё]/.test(value), `${key}: "${value}"`).toBe(true);
    }
  });

  it('{param} бүхий мессежүүд хаалтаа зөв хаасан', () => {
    for (const [k, v] of Object.entries(dict)) expect((v.match(/\{/g) ?? []).length, k).toBe((v.match(/\}/g) ?? []).length);
  });

  it('компонент/логик дотор хэрэглэсэн `score.…` түлхүүр бүр JSON-д бий, JSON-ы түлхүүр бүр хаа нэгтээ хэрэглэгдсэн', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => readFileSync(`${dir}${f}`, 'utf8'));
    const literal = new Set<string>();
    const prefixes = new Set<string>();
    for (const src of sources) {
      for (const m of src.matchAll(/['"`](score\.[A-Za-z0-9_.]+)['"`]/g)) literal.add(m[1]!);
      for (const m of src.matchAll(/`(score\.[A-Za-z0-9_.]*)\$\{/g)) prefixes.add(m[1]!);
    }
    expect([...literal].filter((k) => !has(k)), 'JSON-д байхгүй түлхүүр').toEqual([]);
    const unused = Object.keys(dict).filter((k) => !literal.has(k) && ![...prefixes].some((p) => k.startsWith(p)));
    expect(unused, 'хэрэглэгдээгүй түлхүүр').toEqual([]);
  });

  it('динамик түлхүүрийн бүх гишүүн орчуулгатай (enum бүрийн утга)', () => {
    const expected: string[] = [
      ...ReasonCode.options.map((c) => `score.reason.${c}`),
      ...ReasonStep.options.map((s) => `score.step.${s}`),
      ...CalcMethod.flatMap((m) => [`score.method.${m}`, `score.method.${m}.hint`]),
      ...AutoSelectReason.options.map((r) => `score.autoReason.${r}`),
      ...SOSCO_COMPONENTS.map((c) => `score.sosco.component.${c}`),
      ...SCORING_ERROR_CODES.filter((c) => c !== 'SCORING_UNAVAILABLE').map((c) => `score.error.${c}`),
      ...ERROR_KEYS,
      ...['pass', 'fail', 'na'].map((v) => `score.verdict.${v}`),
      ...['DTI', 'DSCR'].map((r) => `score.ratio.${r}`),
      ...['AUTO', 'MANUAL'].map((s) => `score.selection.${s}`),
      ...['notEditable', 'noCalculation', 'modified', 'stale', 'busy'].map((b) => `score.select.blocked.${b}`),
      ...['notEditable', 'blockers', 'noTerms'].map((b) => `score.calculate.disabled.${b}`),
      ...['initial', 'modified'].flatMap((b) => [`score.alert.preview.${b}.title`, `score.alert.preview.${b}.text`]),
    ];
    expect(expected.filter((k) => !has(k))).toEqual([]);
    expect(SoscoGrade.options).toEqual(['A', 'B', 'C', 'D', 'E']);
  });
});
