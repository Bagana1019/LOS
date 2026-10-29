import { describe, expect, it } from 'vitest';
import { ReportDefinitionView, ReportKey } from '@los/contracts';
import { REPORT_DEFINITIONS, ReportRegistry } from './report-registry';

describe('report registry (тайлан бүрийн тодорхойлолтын нэгдмэл байдал)', () => {
  const registry = new ReportRegistry();

  it('9 тайлан, ReportKey-ийн дарааллаар, давхардалгүй', () => {
    expect(REPORT_DEFINITIONS.map((d) => d.key)).toEqual([...ReportKey]);
    expect(registry.all()).toHaveLength(9);
    expect(registry.get('overdue-loans')?.key).toBe('overdue-loans');
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.get('dashboard')).toBeUndefined();
    expect(registry.has('closed-loans')).toBe(true);
    expect(registry.has('constructor')).toBe(false);
    expect(registry.has('__proto__')).toBe(false);
  });

  it.each(REPORT_DEFINITIONS.map((d) => [d.key, d] as const))('%s: баганы/шүүлт/эрэмбийн дүрэм', (_key, def) => {
    const keys = def.columns.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(def.title.length).toBeGreaterThan(0);
    expect(def.description.length).toBeGreaterThan(0);
    // анхдагч эрэмбэ нь sortable багана
    const dflt = def.columns.find((c) => c.key === def.defaultSort.sortBy);
    expect(dflt?.sortable, 'defaultSort').toBe(true);
    // нийлбэр зөвхөн тоон баганад
    for (const k of def.totalKeys) expect(['money', 'number'], `${def.key}.${k}`).toContain(def.columns.find((c) => c.key === k)?.type);
    // регистр нуугдмал, эрэмбэлэхгүй
    const reg = def.columns.find((c) => c.key === 'registerNo');
    if (reg) expect(reg.sortable).toBe(false);
    // валют багана (олон валют илрүүлэх, нийлбэр холихгүй)
    expect(keys).toContain('currency');
    // status багана options-той
    for (const c of def.columns.filter((x) => x.type === 'status')) expect(c.options?.length, `${def.key}.${c.key}`).toBeGreaterThan(0);
    // select шүүлт options-той; шүүлтийн түлхүүр давхцахгүй
    const fkeys = def.filters.map((f) => f.key);
    expect(new Set(fkeys).size).toBe(fkeys.length);
    for (const f of def.filters.filter((x) => x.type === 'select')) expect(f.options?.length, `${def.key}.${f.key}`).toBeGreaterThan(0);
    expect(fkeys).toEqual(expect.arrayContaining(['branchId', 'officerId', 'search']));
    // contracts-ийн хэлбэрт нийцнэ
    expect(() => ReportDefinitionView.parse({ key: def.key, title: def.title, description: def.description, columns: def.columns, filters: def.filters, dataSource: 'origination', defaultSort: def.defaultSort })).not.toThrow();
  });

  it('dataSource: зөвхөн deposit-balances нь Core (mock/real)', () => {
    const deps = (mode: 'mock' | 'real') => ({ deposit: { mode } as never });
    expect(REPORT_DEFINITIONS.filter((d) => d.dataSource(deps('mock')) !== 'origination').map((d) => d.key)).toEqual(['deposit-balances']);
    const dep = registry.get('deposit-balances')!;
    expect(dep.dataSource(deps('mock'))).toBe('core-mock');
    expect(dep.dataSource(deps('real'))).toBe('core');
  });
});
