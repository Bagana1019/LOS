import { describe, expect, it } from 'vitest';
import { mn } from '@los/ui';
import { diffSides, fieldLabelFor } from './customer-change';
import { diffObjects } from './diff';

const dto = (over: Record<string, unknown>) => ({ targetType: 'CUSTOMER', action: 'UPDATE', before: null, payload: null, ...over });

describe('diffSides: CUSTOMER/UPDATE renders as a flat field diff', () => {
  it('flattens {changes, cleared}: changed fields show before → after, cleared fields show as removed', () => {
    const sides = diffSides(dto({ payload: { changes: { phone: '88445566' }, cleared: ['clanName'] }, before: { phone: '99112233', clanName: 'Боржигон' } }));
    expect(sides.sealedFields).toBeNull();
    expect(diffObjects(sides.before, sides.after)).toEqual([
      { path: 'phone', kind: 'changed', before: '99112233', after: '88445566' },
      { path: 'clanName', kind: 'removed', before: 'Боржигон' },
    ]);
  });

  it('a sealed payload (could not be decrypted) shows only the PII-free field list, never the ciphertext', () => {
    const sides = diffSides(dto({ payload: { sealed: 'v1.k.iv.tag.ct', summary: { fields: ['email', 'phone'] } }, before: { sealed: 'v1.x', summary: { fields: ['phone'] } } }));
    expect(sides.sealedFields).toEqual(['email', 'phone']);
    expect(sides.before).toBeNull();
    expect(sides.after).toBeNull();
  });

  it('a malformed sealed summary yields an empty list instead of crashing', () => {
    expect(diffSides(dto({ payload: { sealed: 'v1', summary: 'nope' } })).sealedFields).toEqual([]);
  });

  it('other request types pass through unchanged', () => {
    const other = { targetType: 'SETTING', action: 'UPDATE', before: { value: 1 }, payload: { value: 2 } };
    expect(diffSides(other)).toEqual({ before: { value: 1 }, after: { value: 2 }, sealedFields: null });
  });
});

describe('fieldLabelFor', () => {
  it('uses the customer form labels for customer requests, including nested paths', () => {
    const label = fieldLabelFor('CUSTOMER');
    expect(label('phone')).toBe(mn['customer.field.phone']);
    expect(label('officialAddress.district')).toBe(`${mn['customer.field.officialAddress']} · district`);
  });
  it('falls back to the raw path for unknown fields and other request types', () => {
    expect(fieldLabelFor('CUSTOMER')('mystery')).toBe('mystery');
    expect(fieldLabelFor('SETTING')('phone')).toBe('phone');
  });
});

describe('i18n', () => {
  it('has a target type label and the sealed notice', () => {
    expect(mn['maker_checker.target_type.CUSTOMER']).toBeTruthy();
    expect(mn['maker_checker.customer.sealed_fields']).toContain('{fields}');
  });
});
