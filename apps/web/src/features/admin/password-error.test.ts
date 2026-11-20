import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/http';
import { classifyPasswordError } from './password-error';

// F9-14: нууц үг солих алдаа. Одоогийн нууц үг буруу бол алдааг ТЭР талбарт заана (сесс хаахгүй).
describe('classifyPasswordError', () => {
  it('pins INVALID_CURRENT_PASSWORD to the current-password field with an actionable message', () => {
    const r = classifyPasswordError(new ApiError(422, 'INVALID_CURRENT_PASSWORD', 'Одоогийн нууц үг буруу байна'));
    expect(r.field).toBe('current');
    expect(r.message).toBe('Одоогийн (түр) нууц үг буруу байна. Түр нууц үгээ анхааралтай дахин оруулна уу');
  });

  it('keeps the legacy 401 mapping as a form-level message', () => {
    expect(classifyPasswordError(new ApiError(401, null, 'x'))).toEqual({ field: null, message: 'Одоогийн нууц үг буруу' });
  });

  it('keeps PASSWORD_UNCHANGED as a form-level message', () => {
    expect(classifyPasswordError(new ApiError(422, 'PASSWORD_UNCHANGED', 'x'))).toEqual({ field: null, message: 'Шинэ нууц үг одоогийнхоос өөр байх ёстой' });
  });

  it('falls back to the error message, then to the generic load error', () => {
    expect(classifyPasswordError(new ApiError(500, null, 'boom'))).toEqual({ field: null, message: 'boom' });
    expect(classifyPasswordError(new Error('offline'))).toEqual({ field: null, message: 'offline' });
    expect(classifyPasswordError('weird').field).toBeNull();
    expect(classifyPasswordError('weird').message).not.toBe('');
  });
});
