import { describe, expect, it } from 'vitest';
import { buildChangeView, targetContext, targetName } from './change-view';
import { diffObjects } from './diff';

const PRODUCT_BEFORE = {
  id: 'p1', code: 'CONSUMER', productType: 'CONSUMER', currency: 'MNT', isActive: true, name: 'Хэрэглээний зээл',
  minAmount: 100000, maxAmount: 5000000, maxLtv: 0.25, maxDti: null, haircut: null,
};
const dto = (over: Record<string, unknown>) => ({ targetType: 'PRODUCT', action: 'UPDATE', before: null, payload: null, ...over });
const rows = (view: ReturnType<typeof buildChangeView>) => diffObjects(view.before, view.after);

describe('buildChangeView: BLACKLIST_ENTRY / ACTIVATE_BLACK (F8-3)', () => {
  const blacklist = dto({
    targetType: 'BLACKLIST_ENTRY', action: 'ACTIVATE_BLACK', payload: { entryId: 'e1' },
    before: { entryId: 'e1', severity: 'GREY', pendingSeverity: 'BLACK', isActive: false, listType: 'DELINQUENT', reasonCode: 'FRAUD_CASE' },
  });

  it('shows what approving does (level → Хар, active) instead of marking every before-field as removed', () => {
    expect(rows(buildChangeView(blacklist))).toEqual([
      { path: 'severity', kind: 'changed', before: 'GREY', after: 'BLACK' },
      { path: 'isActive', kind: 'changed', before: false, after: true },
    ]);
  });

  it('explains the effect in a note', () => {
    expect(buildChangeView(blacklist).note).toContain('Хар');
  });

  it('an entry that is already Хар and active yields an empty diff', () => {
    const same = { ...blacklist, before: { severity: 'BLACK', isActive: true } };
    expect(rows(buildChangeView(same))).toEqual([]);
  });

  it('a missing snapshot does not crash', () => {
    expect(() => rows(buildChangeView({ ...blacklist, before: null }))).not.toThrow();
  });

  it('labels and values come from the blacklist tables', () => {
    const view = buildChangeView(blacklist);
    expect(view.labelOf('severity')).toBe('Түвшин');
    expect(view.valueOf('severity', 'GREY')).toBe('Саарал');
    expect(view.valueOf('isActive', true)).toBe('Тийм');
  });
});

describe('buildChangeView: PRODUCT (F9-5)', () => {
  it('UPDATE compares the editable fields only: no id/code noise, only the real changes', () => {
    const view = buildChangeView(dto({
      before: PRODUCT_BEFORE,
      payload: { id: 'p1', product: { name: 'Хэрэглээний зээл', minAmount: 5, maxAmount: 5000000, maxLtv: 1, maxDti: null, haircut: null } },
    }));
    expect(rows(view)).toEqual([
      { path: 'minAmount', kind: 'changed', before: 100000, after: 5 },
      { path: 'maxLtv', kind: 'changed', before: 0.25, after: 1 },
    ]);
  });

  it('CREATE has no before; every proposed field is shown, unwrapped from payload.product', () => {
    const view = buildChangeView(dto({ action: 'CREATE', before: null, payload: { product: { code: 'NEW', name: 'Шинэ', maxLtv: 0.5 } } }));
    expect(view.before).toBeNull();
    expect(rows(view).map((r) => r.path)).toEqual(['code', 'name', 'maxLtv']);
  });

  it('SET_ACTIVE compares only isActive: the payload id is not an "added" field', () => {
    const view = buildChangeView(dto({ action: 'SET_ACTIVE', before: { isActive: true }, payload: { id: 'p1', isActive: false } }));
    expect(rows(view)).toEqual([{ path: 'isActive', kind: 'changed', before: true, after: false }]);
  });

  it('labels the fields and formats values with units', () => {
    const view = buildChangeView(dto({ before: PRODUCT_BEFORE, payload: { id: 'p1', product: {} } }));
    expect(view.labelOf('maxLtv')).toBe('Дээд LTV');
    expect(view.valueOf('maxLtv', 1)).toBe('100%');
    expect(view.valueOf('minAmount', 5)).toBe('5₮');
  });

  it('an unknown field keeps its raw path and plain value', () => {
    const view = buildChangeView(dto({ before: PRODUCT_BEFORE, payload: { id: 'p1', product: {} } }));
    expect(view.labelOf('somethingNew')).toBe('somethingNew');
    expect(view.valueOf('somethingNew', 7)).toBe('7');
    expect(view.valueOf('somethingNew', null)).toBe('null');
  });

  it('a malformed payload does not crash', () => {
    expect(() => rows(buildChangeView(dto({ before: PRODUCT_BEFORE, payload: 'oops' })))).not.toThrow();
    expect(() => rows(buildChangeView(dto({ before: 'oops', payload: null })))).not.toThrow();
  });
});

describe('buildChangeView: everything else', () => {
  it('other types pass the snapshot and payload through unchanged', () => {
    const view = buildChangeView({ targetType: 'SETTING', action: 'UPDATE', before: { value: 1 }, payload: { value: 2 } });
    expect(view.before).toEqual({ value: 1 });
    expect(view.after).toEqual({ value: 2 });
    expect(view.note).toBeNull();
    expect(view.labelOf('value')).toBe('value');
  });

  it('CUSTOMER keeps its own flattening and form labels', () => {
    const view = buildChangeView({ targetType: 'CUSTOMER', action: 'UPDATE', before: { phone: '1' }, payload: { changes: { phone: '2' }, cleared: [] } });
    expect(rows(view)).toEqual([{ path: 'phone', kind: 'changed', before: '1', after: '2' }]);
    expect(view.labelOf('phone')).not.toBe('phone');
  });
});

describe('targetContext: who and why for a blacklist request (F8-3)', () => {
  const req = dto({
    targetType: 'BLACKLIST_ENTRY', action: 'ACTIVATE_BLACK', payload: { entryId: 'e1' },
    before: { severity: 'GREY', listType: 'DELINQUENT', reasonCode: 'FRAUD_CASE' },
  });

  it('shows the masked register, list type and reason in Mongolian once the entry is loaded', () => {
    const rowsOf = targetContext(req, { registerNo: 'УБ12345678', reasonText: 'Шүүхийн шийдвэр №12' });
    expect(rowsOf.map((r) => r.value)).toEqual(['УБ••••5678', 'Зээлийн хугацаа хэтрэлт', 'Залилангийн хэрэг', 'Шүүхийн шийдвэр №12']);
  });

  it('without the entry (not loaded / no access) it still shows the codes from the snapshot, never the register', () => {
    const rowsOf = targetContext(req, null);
    expect(rowsOf.map((r) => r.value)).toEqual(['Зээлийн хугацаа хэтрэлт', 'Залилангийн хэрэг']);
  });

  it('an unknown reason code falls back to the raw code; other target types add nothing', () => {
    expect(targetContext({ ...req, before: { reasonCode: 'WEIRD_CODE' } }, null).map((r) => r.value)).toEqual(['WEIRD_CODE']);
    expect(targetContext(dto({}), null)).toEqual([]);
  });
});

describe('targetName: a readable name for the target instead of its UUID', () => {
  it('blacklist: the looked-up entry name; null until/unless it is loaded', () => {
    const req = dto({ targetType: 'BLACKLIST_ENTRY', action: 'ACTIVATE_BLACK', targetId: 'e1' });
    expect(targetName(req, { blacklistName: 'Дорж Баатар' })).toBe('Дорж Баатар');
    expect(targetName(req, {})).toBeNull();
  });

  it('product: the name from the snapshot, else from the proposed payload, else from the product lookup', () => {
    expect(targetName(dto({ before: PRODUCT_BEFORE }), {})).toBe('Хэрэглээний зээл');
    expect(targetName(dto({ action: 'CREATE', payload: { product: { name: 'Шинэ' } } }), {})).toBe('Шинэ');
    expect(targetName(dto({ action: 'SET_ACTIVE', before: { isActive: true }, payload: { id: 'p1', isActive: false } }), { productName: 'Хэрэглээний зээл' })).toBe('Хэрэглээний зээл');
    expect(targetName(dto({ action: 'SET_ACTIVE', before: { isActive: true }, payload: { id: 'p1', isActive: false } }), {})).toBeNull();
  });

  it('other types have no resolvable name', () => {
    expect(targetName({ targetType: 'SETTING', action: 'UPDATE', before: null, payload: null }, {})).toBeNull();
    expect(targetName({ targetType: 'SETTING', action: 'UPDATE', before: null, payload: null }, { blacklistName: 'x', productName: 'y' })).toBeNull();
  });
});
