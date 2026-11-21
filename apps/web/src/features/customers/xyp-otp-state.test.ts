import { describe, expect, it } from 'vitest';
import { isOtpCodeUnusable } from './xyp-otp-state';

// F1-7: оролдлого дууссан (эсвэл код илгээгдээгүй) бол ЭНЭ кодоор дахин баталгаажуулах боломжгүй — товч идэвхгүй, шинэ код авна.
describe('isOtpCodeUnusable', () => {
  it('is true when the server says attempts are exhausted or no code is outstanding', () => {
    expect(isOtpCodeUnusable('XYP_OTP_ATTEMPTS_EXHAUSTED')).toBe(true);
    expect(isOtpCodeUnusable('XYP_OTP_NOT_REQUESTED')).toBe(true);
  });
  it('is false for a plain wrong code (the user may retry), rate limits, other errors and no error', () => {
    expect(isOtpCodeUnusable('XYP_OTP_INVALID')).toBe(false);
    expect(isOtpCodeUnusable('XYP_OTP_RATE_LIMITED')).toBe(false);
    expect(isOtpCodeUnusable('XYP_UNAVAILABLE')).toBe(false);
    expect(isOtpCodeUnusable(null)).toBe(false);
    expect(isOtpCodeUnusable(undefined)).toBe(false);
  });
});
