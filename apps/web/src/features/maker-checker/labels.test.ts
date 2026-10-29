import { describe, expect, it } from 'vitest';
import { mn } from '@los/ui';
import { ChangeRequestEvent, ChangeRequestMode, ChangeRequestStatus } from '@los/contracts';
import {
  CHECKER_ROLES,
  EVENT_COLOR,
  MODE_COLOR,
  STATUS_COLOR,
  changeActionLabel,
  describeChange,
  eventColor,
  eventLabel,
  fmt,
  modeLabel,
  roleLabel,
  statusColor,
  statusLabel,
  targetTypeLabel,
} from './labels';

describe('fmt', () => {
  it('replaces placeholders, including repeated ones, and stringifies numbers', () => {
    expect(fmt('{a} + {a} = {b}', { a: 1, b: 2 })).toBe('1 + 1 = 2');
  });
  it('leaves unknown placeholders and plain text untouched', () => {
    expect(fmt('Нийт {total}', {})).toBe('Нийт {total}');
    expect(fmt('plain', { x: 1 })).toBe('plain');
    expect(fmt('{toString}', {})).toBe('{toString}');
  });
});

describe('label completeness (every contract enum value has a Mongolian text)', () => {
  it.each(ChangeRequestStatus)('status %s', (s) => {
    expect(mn[`maker_checker.status.${s}`]).toBeTruthy();
    expect(statusLabel(s)).toBe(mn[`maker_checker.status.${s}`]);
    expect(STATUS_COLOR[s]).toBeTruthy();
  });
  it.each(ChangeRequestEvent)('event %s', (e) => {
    expect(mn[`maker_checker.event.${e}`]).toBeTruthy();
    expect(eventLabel(e)).toBe(mn[`maker_checker.event.${e}`]);
    expect(EVENT_COLOR[e]).toBeTruthy();
  });
  it.each(ChangeRequestMode)('mode %s', (m) => {
    expect(mn[`maker_checker.mode.${m}`]).toBeTruthy();
    expect(modeLabel(m)).toBe(mn[`maker_checker.mode.${m}`]);
    expect(MODE_COLOR[m]).toBeTruthy();
  });
  it.each(CHECKER_ROLES)('role %s', (r) => {
    expect(roleLabel(r)).toBe(mn[`maker_checker.role.${r}`]);
    expect(roleLabel(r)).not.toBe(r);
  });
});

describe('graceful fallback to the raw code', () => {
  it('returns the code when there is no label', () => {
    expect(statusLabel('WEIRD')).toBe('WEIRD');
    expect(eventLabel('WEIRD')).toBe('WEIRD');
    expect(modeLabel('WEIRD')).toBe('WEIRD');
    expect(roleLabel('UNDERWRITER')).toBe('UNDERWRITER');
    expect(targetTypeLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(changeActionLabel('REVOKE')).toBe('REVOKE');
  });
  it('uses neutral colours for unknown codes', () => {
    expect(statusColor('WEIRD')).toBe('default');
    expect(statusColor('constructor')).toBe('default');
    expect(eventColor('WEIRD')).toBe('gray');
    expect(eventColor('toString')).toBe('gray');
  });
  it('maps known codes to their colour', () => {
    expect(statusColor('PENDING')).toBe(STATUS_COLOR.PENDING);
    expect(eventColor('REJECTED')).toBe(EVENT_COLOR.REJECTED);
  });
});

describe('describeChange', () => {
  it('combines the type and action labels and keeps the raw code as secondary text', () => {
    expect(describeChange('MAKER_CHECKER_POLICY', 'UPDATE')).toEqual({
      title: `${mn['maker_checker.target_type.MAKER_CHECKER_POLICY']} · ${mn['maker_checker.change_action.UPDATE']}`,
      code: 'MAKER_CHECKER_POLICY / UPDATE',
    });
  });
  it('labels a known action on an unknown type, falling back to the raw type', () => {
    expect(describeChange('NEW_THING', 'DELETE')).toEqual({
      title: `NEW_THING · ${mn['maker_checker.change_action.DELETE']}`,
      code: 'NEW_THING / DELETE',
    });
  });
  it('shows only the raw code when nothing is known', () => {
    expect(describeChange('NEW_THING', 'REVOKE')).toEqual({ title: 'NEW_THING / REVOKE', code: null });
  });
});

describe('mn.maker-checker.json', () => {
  it('prefixes every key with maker_checker. and has no empty strings', () => {
    const own = Object.entries(mn).filter(([k]) => k.startsWith('maker_checker.'));
    expect(own.length).toBeGreaterThan(100);
    for (const [, v] of own) expect(v.trim()).not.toBe('');
  });
});
