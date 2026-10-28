import { describe, it, expect } from 'vitest';
import { annuityPayment } from './schedule';
describe('annuityPayment', () => {
  it('30,000,000 @ 23.99% / 36 сар ≈ 1,176,828 (docs/04 M07 AC)', () => {
    expect(Math.abs(annuityPayment(30_000_000, 23.99, 36) - 1_176_828)).toBeLessThan(2);
  });
});
