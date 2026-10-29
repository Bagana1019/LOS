import { describe, expect, it } from 'vitest';
import type { AmlSubject } from '@los/contracts';
import { subjectIdentityKey } from './subject-identity';

const base: AmlSubject = {
  subjectType: 'INDIVIDUAL', registerNo: 'ХИ87654321', lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ', aliases: ['Bat Erdene', 'B. Ganbold'],
  birthDate: '1980-05-17', countries: ['MN', 'KZ'], isPep: false, isRelatedParty: false,
};
const key = (over: Partial<AmlSubject> = {}) => subjectIdentityKey({ ...base, ...over });

describe('subjectIdentityKey', () => {
  it('is a stable string for the same subject', () => {
    expect(typeof key()).toBe('string');
    expect(key()).toBe(key());
  });

  it('ignores the register number (compared through registerNoHash) and the PEP / related-party flags', () => {
    expect(key({ registerNo: 'ЖЖ11111111' })).toBe(key());
    expect(key({ isPep: true, isRelatedParty: true })).toBe(key());
  });

  it('normalises text: NFKC, case, surrounding and repeated whitespace', () => {
    expect(key({ lastName: '  ГАНБОЛД ', firstName: 'бат-эрдэнэ' })).toBe(key());
    expect(key({ lastName: 'Ｇａｎｂｏｌｄ', firstName: 'Ｂａｔ  \t Ｅｒｄｅｎｅ' })).toBe(key({ lastName: 'ganbold', firstName: 'bat erdene' }));
  });

  it('treats an absent last name like an empty one', () => {
    expect(key({ lastName: undefined })).toBe(key({ lastName: '' }));
    expect(key({ lastName: undefined })).not.toBe(key());
  });

  it('ignores the order and duplicates of aliases and countries (after normalisation)', () => {
    expect(key({ aliases: ['B. Ganbold', 'Bat Erdene'] })).toBe(key());
    expect(key({ aliases: ['Bat Erdene', 'bat  erdene', 'B. Ganbold', ' B. GANBOLD'] })).toBe(key());
    expect(key({ countries: ['KZ', 'MN', 'MN'] })).toBe(key());
    expect(key({ countries: ['mn', 'kz'] })).toBe(key());
  });

  it('changes with the subject type, either name, any alias, the birth date and the countries', () => {
    const changed = [
      key({ subjectType: 'LEGAL_ENTITY' }),
      key({ lastName: 'Иванов' }),
      key({ firstName: 'Иван' }),
      key({ aliases: ['Bat Erdene'] }),
      key({ aliases: [...base.aliases, 'Another Alias'] }),
      key({ aliases: [] }),
      key({ birthDate: '1980-05-18' }),
      key({ birthDate: undefined }),
      key({ countries: ['MN'] }),
      key({ countries: ['MN', 'KZ', 'KP'] }),
    ];
    for (const k of changed) expect(k).not.toBe(key());
    expect(new Set(changed).size).toBe(changed.length);
  });

  it('does not confuse the last and the first name', () => {
    expect(key({ lastName: 'Бат', firstName: 'Ганболд' })).not.toBe(key({ lastName: 'Ганболд', firstName: 'Бат' }));
  });

  it('reads a stored snapshot (no registerNo) the same way as a request subject', () => {
    const { registerNo: _registerNo, ...snapshot } = base;
    expect(subjectIdentityKey(snapshot)).toBe(key());
  });
});
