import { describe, expect, it } from 'vitest';
import type { OrgDirectory, ReportFilterDef } from '@los/contracts';
import { t } from '../../lib/i18n';
import { scopeText } from './dashboard.utils';
import { directoryCellText, directoryColumnKind, directoryOptions, lookupKindOf, lookupScopeOf, nameInMap, scopeNames, selectModel, type LookupOption } from './report-lookups';
import { normalizeFilterValue, parseFilters } from './reports.utils';

// F11-1: салбар / ЗЭЗ / бүтээгдэхүүний шүүлт нэрээр сонгодог (утга = id), танихгүй id-г чимээгүй зөвшөөрөхгүй.
const HQ = '00000000-0000-4000-8000-000000000101';
const SBD = '00000000-0000-4000-8000-000000000102';
const UNKNOWN = '00000000-0000-4000-8000-000000000999';

const DIR: OrgDirectory = {
  branches: { [SBD]: 'Сүхбаатар салбар', [HQ]: 'Төв салбар' },
  users: { u2: 'Оюунчимэг Батсайхан', u1: 'Батаа Дорж' },
};

describe('lookupKindOf', () => {
  it('only branchId / officerId / productId are lookup filters', () => {
    expect(lookupKindOf('branchId')).toBe('branch');
    expect(lookupKindOf('officerId')).toBe('officer');
    expect(lookupKindOf('productId')).toBe('product');
    for (const k of ['search', 'status', 'currency', 'dateFrom', '', 'constructor', '__proto__', 'toString']) expect(lookupKindOf(k), k).toBeNull();
  });
});

describe('lookupScopeOf (mirrors the server report scope, NFR-3)', () => {
  const user = (roles: string[], branchId: string | null = 'b1') => ({ id: 'u1', branchId, roles }) as Parameters<typeof lookupScopeOf>[0];
  it('no user, ADMIN, APPROVER: nothing is restricted', () => {
    const none = { branchId: null, officerId: null };
    expect(lookupScopeOf(undefined)).toEqual(none);
    expect(lookupScopeOf(user(['ADMIN']))).toEqual(none);
    expect(lookupScopeOf(user(['APPROVER']))).toEqual(none);
  });
  it('BRANCH_MANAGER is pinned to the own branch, officers stay open', () => {
    expect(lookupScopeOf(user(['BRANCH_MANAGER']))).toEqual({ branchId: 'b1', officerId: null });
  });
  it('OFFICER is pinned to self and to the own branch when known', () => {
    expect(lookupScopeOf(user(['OFFICER']))).toEqual({ branchId: 'b1', officerId: 'u1' });
    expect(lookupScopeOf(user(['OFFICER'], null))).toEqual({ branchId: null, officerId: 'u1' });
  });
  it('widest role wins (OFFICER + BRANCH_MANAGER = branch, OFFICER + ADMIN = all)', () => {
    expect(lookupScopeOf(user(['OFFICER', 'BRANCH_MANAGER']))).toEqual({ branchId: 'b1', officerId: null });
    expect(lookupScopeOf(user(['OFFICER', 'ADMIN']))).toEqual({ branchId: null, officerId: null });
  });
});

describe('nameInMap', () => {
  it('returns the trimmed own-property name, null otherwise', () => {
    expect(nameInMap({ a: '  Төв  ' }, 'a')).toBe('Төв');
    expect(nameInMap({ a: '   ' }, 'a')).toBeNull();
    expect(nameInMap({ a: 'x' }, 'b')).toBeNull();
    expect(nameInMap({}, 'constructor')).toBeNull();
    expect(nameInMap({}, '__proto__')).toBeNull();
    expect(nameInMap(undefined, 'a')).toBeNull();
  });
});

describe('directoryOptions', () => {
  it('builds {value: id, label: name} sorted by name', () => {
    expect(directoryOptions(DIR.branches, null)).toEqual([
      { value: SBD, label: 'Сүхбаатар салбар' },
      { value: HQ, label: 'Төв салбар' },
    ]);
  });
  it('is empty without a directory and skips blank names', () => {
    expect(directoryOptions(undefined, null)).toEqual([]);
    expect(directoryOptions({ a: ' ', b: 'Бат' }, null)).toEqual([{ value: 'b', label: 'Бат' }]);
  });
  it('restricts to the scope id; an id missing from the directory yields nothing', () => {
    expect(directoryOptions(DIR.branches, HQ)).toEqual([{ value: HQ, label: 'Төв салбар' }]);
    expect(directoryOptions(DIR.branches, UNKNOWN)).toEqual([]);
  });
  it('keeps same-named entries apart by appending the id tail', () => {
    const out = directoryOptions({ '00000000-0000-4000-8000-00000000aaa1': 'Бат', '00000000-0000-4000-8000-00000000bbb2': 'Бат', x: 'Дорж' }, null);
    expect(out.map((o) => o.label).sort()).toEqual(['Бат · aaa1', 'Бат · bbb2', 'Дорж']);
    expect(new Set(out.map((o) => o.label)).size).toBe(3);
  });
});

describe('selectModel', () => {
  const options: LookupOption[] = [{ value: HQ, label: 'Төв салбар' }];
  const nameOf = (id: string) => nameInMap(DIR.branches, id);

  it('empty value or a value that is an option: untouched, not flagged', () => {
    expect(selectModel({ options, value: '', nameOf, ready: true })).toEqual({ options, notFound: false });
    expect(selectModel({ options, value: HQ, nameOf, ready: true })).toEqual({ options, notFound: false });
  });
  it('a known id outside the offered options (out of scope) shows its name and is not "not found"', () => {
    expect(selectModel({ options, value: SBD, nameOf, ready: true })).toEqual({ options: [...options, { value: SBD, label: 'Сүхбаатар салбар' }], notFound: false });
  });
  it('an unknown id keeps the raw value as its label and is flagged once the lookup is ready', () => {
    expect(selectModel({ options, value: UNKNOWN, nameOf, ready: true })).toEqual({ options: [...options, { value: UNKNOWN, label: UNKNOWN }], notFound: true });
  });
  it('an unknown id is not flagged while the lookup is still loading or failed (we cannot know)', () => {
    expect(selectModel({ options, value: UNKNOWN, nameOf, ready: false }).notFound).toBe(false);
  });
  it('never mutates the offered options', () => {
    const before = [...options];
    selectModel({ options, value: UNKNOWN, nameOf, ready: true });
    expect(options).toEqual(before);
  });
});

describe('scopeNames + scopeText (header echo shows names, never a bare UUID)', () => {
  it('branch / officer name from the directory', () => {
    const names = scopeNames(DIR, 'ready', t);
    expect(scopeText({ branchId: HQ, officerId: null }, t, names)).toBe('салбар Төв салбар');
    expect(scopeText({ branchId: null, officerId: 'u1' }, t, names)).toBe('ЗЭЗ Батаа Дорж');
    expect(scopeText({ branchId: null, officerId: null }, t, names)).toBe('бүх салбар');
  });
  it('an id that is not in the directory is labelled "not found" instead of echoed as if valid', () => {
    expect(scopeText({ branchId: UNKNOWN, officerId: null }, t, scopeNames(DIR, 'ready', t))).toBe(`салбар олдсонгүй (${UNKNOWN})`);
  });
  it('while the directory is loading a placeholder is shown, not the UUID', () => {
    expect(scopeText({ branchId: HQ, officerId: null }, t, scopeNames(undefined, 'loading', t))).toBe('салбар —');
  });
  it('when the directory failed to load the raw id is all we have', () => {
    expect(scopeText({ branchId: HQ, officerId: null }, t, scopeNames(undefined, 'failed', t))).toBe(`салбар ${HQ}`);
  });
  it('without names the legacy behaviour (ids) is unchanged', () => {
    expect(scopeText({ branchId: 'b1', officerId: null }, t)).toBe('салбар b1');
  });
});

describe('URL filter values for lookup filters are kept, not silently dropped', () => {
  const product: ReportFilterDef = { key: 'productId', label: 'Бүтээгдэхүүн', type: 'select', options: [{ value: 'p1', label: 'Хэрэглээний зээл' }] };
  const status: ReportFilterDef = { key: 'status', label: 'Төлөв', type: 'select', options: [{ value: 'ACTIVE', label: 'Идэвхтэй' }] };

  it('an unknown productId is preserved (so the UI can flag it and the API request keeps the typed id)', () => {
    expect(normalizeFilterValue(product, UNKNOWN)).toBe(UNKNOWN);
    expect(parseFilters({ get: (k) => (k === 'productId' ? UNKNOWN : null) }, [product])).toEqual({ productId: UNKNOWN });
  });
  it('a non-lookup select still rejects values outside its options', () => {
    expect(normalizeFilterValue(status, 'BOGUS')).toBeNull();
    expect(normalizeFilterValue(status, 'ACTIVE')).toBe('ACTIVE');
  });
});

// F11-4 c: JSON тайлангийн хүснэгтийн "Салбар" / "ЗЭЗ" баганад түүхий UUID биш нэр (Excel-тэй адил).
describe('directoryColumnKind', () => {
  it('only the branchId / officerId report columns are directory columns', () => {
    expect(directoryColumnKind('branchId')).toBe('branch');
    expect(directoryColumnKind('officerId')).toBe('officer');
    for (const k of ['productId', 'appNo', 'customerName', '', 'constructor', '__proto__']) expect(directoryColumnKind(k), k).toBeNull();
  });
});

describe('directoryCellText (report table cell: a name, never a bare id)', () => {
  const ready = { directory: DIR, status: 'ready' as const };
  const UNKNOWN_NAME = 'Тодорхойгүй';

  it('a known branch / officer id resolves to its name', () => {
    expect(directoryCellText('branch', HQ, ready, t)).toBe('Төв салбар');
    expect(directoryCellText('officer', 'u1', ready, t)).toBe('Батаа Дорж');
  });
  it('an id missing from the directory is "Тодорхойгүй" and the id is not echoed', () => {
    expect(directoryCellText('branch', UNKNOWN, ready, t)).toBe(UNKNOWN_NAME);
    expect(directoryCellText('officer', 'nobody', ready, t)).toBe(UNKNOWN_NAME);
  });
  it('a branch column never resolves through the user map (and vice versa)', () => {
    expect(directoryCellText('branch', 'u1', ready, t)).toBe(UNKNOWN_NAME);
    expect(directoryCellText('officer', HQ, ready, t)).toBe(UNKNOWN_NAME);
  });
  it('prototype keys and blank names are not names', () => {
    for (const id of ['__proto__', 'constructor', 'toString']) expect(directoryCellText('branch', id, ready, t), id).toBe(UNKNOWN_NAME);
    expect(directoryCellText('branch', 'b-blank', { directory: { branches: { 'b-blank': '   ' }, users: {} }, status: 'ready' }, t)).toBe(UNKNOWN_NAME);
  });
  it('"Систем" (BR-12: request without an officer) is a label, not an id: kept for the officer column only', () => {
    expect(directoryCellText('officer', 'Систем', ready, t)).toBe('Систем');
    expect(directoryCellText('branch', 'Систем', ready, t)).toBe(UNKNOWN_NAME);
  });
  it('while the directory loads a placeholder is shown, never the id', () => {
    expect(directoryCellText('branch', HQ, { directory: undefined, status: 'loading' }, t)).toBe('—');
  });
  it('when the directory failed to load the name is unknown (still never the id)', () => {
    expect(directoryCellText('branch', HQ, { directory: undefined, status: 'failed' }, t)).toBe(UNKNOWN_NAME);
  });
});
