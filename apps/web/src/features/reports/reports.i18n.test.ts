import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import mnBase from '../../../../../packages/ui/src/i18n/mn.json';
import mnReport from '../../../../../packages/ui/src/i18n/mn.report.json';
import { ERROR_KEYS } from './reports.utils';

const dir = fileURLToPath(new URL('.', import.meta.url));
const appDir = fileURLToPath(new URL('../../app/los/', import.meta.url));
const read = (f: string) => readFileSync(`${dir}${f}`, 'utf8');
const files = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'));
const pageFiles = ['report/page.tsx', 'report/[key]/page.tsx', 'dashboard/page.tsx'].map((f) => `${appDir}${f}`);
const sources = [...files.map(read), ...pageFiles.map((f) => readFileSync(f, 'utf8'))];

const report = mnReport as Record<string, string>;
const base = mnBase as Record<string, string>;

describe('i18n', () => {
  it('кодонд хэрэглэсэн `report.…` түлхүүр бүр JSON-д бий, JSON-ы түлхүүр бүр хаа нэгтээ хэрэглэгдсэн', () => {
    const literal = new Set<string>();
    for (const src of sources) for (const m of src.matchAll(/['"`](report\.[A-Za-z0-9_.-]+)['"`]/g)) literal.add(m[1]);
    expect([...literal].filter((k) => !(k in report)), 'JSON-д байхгүй түлхүүр').toEqual([]);
    expect(Object.keys(report).filter((k) => !literal.has(k)), 'хэрэглэгдээгүй түлхүүр').toEqual([]);
  });

  it('dashboard-д ашиглах `status.…` түлхүүр бүр суурь mn.json-д бий', () => {
    const keys = new Set<string>();
    for (const src of sources) for (const m of src.matchAll(/['"`](status\.[A-Z_]+)['"`]/g)) keys.add(m[1]);
    expect(keys.size).toBe(9);
    expect([...keys].filter((k) => !(k in base))).toEqual([]);
  });

  it('JSON-ы бүх түлхүүр `report.` угтвартай, утга нь хоосон биш, баталгаат монгол', () => {
    for (const [k, v] of Object.entries(report)) {
      expect(k.startsWith('report.'), k).toBe(true);
      expect(v.trim().length, k).toBeGreaterThan(0);
      expect(v, k).toBe(v.trim());
    }
  });

  it('{param} бүхий мессежүүд хаалтаа зөв хаасан', () => {
    for (const [k, v] of Object.entries(report)) expect((v.match(/\{/g) ?? []).length, k).toBe((v.match(/\}/g) ?? []).length);
  });

  it('ERROR_KEYS-ийн түлхүүр бүр JSON-д бий', () => {
    for (const [code, key] of Object.entries(ERROR_KEYS)) expect(report[key], code).toBeTruthy();
  });

  it('component дотор hard-code монгол мөр байхгүй (JSX текст, title/placeholder/message пропс)', () => {
    const cyr = /[Ѐ-ӿ]/;
    const tsx = [...files.filter((f) => f.endsWith('.tsx')).map((f) => ({ name: f, text: read(f) })), ...pageFiles.map((f) => ({ name: f, text: readFileSync(f, 'utf8') }))];
    const offenders: string[] = [];
    for (const { name, text } of tsx) {
      text.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').replace(/^\s*\*.*$/, '');
        if (cyr.test(code)) offenders.push(`${name}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('UI-ийн ангиллын нэр backend-ийн (Excel/хүснэгтийн) шошготой ижил', () => {
    const labels = fileURLToPath(new URL('../../../../origination/src/modules/report/report-labels.ts', import.meta.url));
    if (!existsSync(labels)) return;
    const text = readFileSync(labels, 'utf8');
    const grab = (name: string): Record<string, string> => {
      const m = new RegExp(`export const ${name} = opts\\(\\{([\\s\\S]*?)\\}\\);`).exec(text);
      return Object.fromEntries([...(m?.[1] ?? '').matchAll(/(\w+):\s*'([^']*)'/g)].map((x) => [x[1], x[2]]));
    };
    const aging = grab('AGING_BUCKET');
    expect(Object.keys(aging)).toHaveLength(5);
    for (const [code, label] of Object.entries(aging)) expect(report[`report.aging.${code}`], code).toBe(label);
    const statuses = grab('APPLICATION_STATUS');
    expect(Object.keys(statuses)).toHaveLength(9);
    for (const [code, label] of Object.entries(statuses)) expect(base[`status.${code}`], code).toBe(label);
  });
});
