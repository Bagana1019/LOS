import { describe, expect, it } from 'vitest';
import type { AmlHit } from '@los/contracts';
import { deriveScreeningStatus, isBlocking } from './screening-status';

const hit = (severity: AmlHit['severity'], status: AmlHit['status']) => ({ severity, status });

describe('deriveScreeningStatus', () => {
  it('is CLEAR without hits', () => expect(deriveScreeningStatus([])).toBe('CLEAR'));
  it('needs review while a BLOCKING hit is open', () => {
    expect(deriveScreeningStatus([hit('BLOCKING', 'OPEN'), hit('WARNING', 'OPEN')])).toBe('REVIEW_REQUIRED');
  });
  it('is CONFIRMED_MATCH once a BLOCKING hit is confirmed, even if others are open', () => {
    expect(deriveScreeningStatus([hit('BLOCKING', 'CONFIRMED'), hit('BLOCKING', 'OPEN')])).toBe('CONFIRMED_MATCH');
  });
  it('only warns for WARNING hits (BR-9), open or confirmed', () => {
    expect(deriveScreeningStatus([hit('WARNING', 'OPEN')])).toBe('WARNING');
    expect(deriveScreeningStatus([hit('WARNING', 'CONFIRMED')])).toBe('WARNING');
  });
  it('keeps WARNING when the blocking hit was cleared but a warning remains', () => {
    expect(deriveScreeningStatus([hit('BLOCKING', 'FALSE_POSITIVE'), hit('WARNING', 'OPEN')])).toBe('WARNING');
  });
  it('is CLEARED_AFTER_REVIEW when every hit is a false positive', () => {
    expect(deriveScreeningStatus([hit('BLOCKING', 'FALSE_POSITIVE'), hit('WARNING', 'FALSE_POSITIVE')])).toBe('CLEARED_AFTER_REVIEW');
  });
});

describe('isBlocking', () => {
  it.each([
    ['CLEAR', false], ['WARNING', false], ['CLEARED_AFTER_REVIEW', false], ['REVIEW_REQUIRED', true], ['CONFIRMED_MATCH', true],
  ] as const)('%s -> %s', (status, expected) => expect(isBlocking(status)).toBe(expected));
});
