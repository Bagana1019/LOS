import { describe, expect, it } from 'vitest';
import { auditActionLabel, cleanRegisterInput, listTypeLabel, maskRegister, reasonLabel } from './blacklist.utils';

describe('blacklist utils', () => {
  it('normalises the register input (no spaces, upper case)', () => {
    expect(cleanRegisterInput(' уб 1234 5678 ')).toBe('УБ12345678');
  });
  it('masks the middle of a register number and leaves short values', () => {
    expect(maskRegister('УБ12345678')).toBe('УБ••••5678');
    expect(maskRegister('AB123')).toBe('AB123');
  });
  it('labels known codes in Mongolian and falls back to the raw code for imported ones', () => {
    expect(reasonLabel('FRAUD_CASE')).toBe('Залилангийн хэрэг');
    expect(reasonLabel('CUSTOM_X')).toBe('CUSTOM_X');
    expect(listTypeLabel('WATCH')).toBe('Ажиглалт');
    expect(listTypeLabel('OTHER_LIST')).toBe('OTHER_LIST');
    expect(auditActionLabel('DEACTIVATE')).toBe('Идэвхгүй болгосон');
    expect(auditActionLabel('X')).toBe('X');
  });
});
