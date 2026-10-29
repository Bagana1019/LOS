import { describe, expect, it } from 'vitest';
import { hasScreenableName, subjectNames, yearOf } from './subject-names';

describe('subjectNames', () => {
  it('joins last and first name and appends aliases', () => {
    expect(subjectNames({ lastName: 'Бат', firstName: 'Эрдэнэ', aliases: ['Bat Erdene'] })).toEqual(['Бат Эрдэнэ', 'Bat Erdene']);
  });
  it('uses the first name alone for legal entities', () => {
    expect(subjectNames({ firstName: 'Монгол Трейд ХХК', aliases: [] })).toEqual(['Монгол Трейд ХХК']);
  });
  it('drops blanks and duplicates', () => {
    expect(subjectNames({ lastName: ' ', firstName: 'Эрдэнэ', aliases: ['Эрдэнэ', ' ', 'Erdene'] })).toEqual(['Эрдэнэ', 'Erdene']);
  });
});

describe('hasScreenableName', () => {
  it('is true for ordinary names, in any script', () => {
    expect(hasScreenableName({ lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ', aliases: [] })).toBe(true);
    expect(hasScreenableName({ firstName: 'محمد', aliases: [] })).toBe(true);
    expect(hasScreenableName({ firstName: '88', aliases: [] })).toBe(true);
  });

  // [11]: нормчлогдоод хоосон болох нэрээр нэрийн тулгалт огт ажиллахгүй, гэтэл screening "CLEAR" болдог байсан
  it.each([['---'], ['...'], ['()'], ['\u200b'], ['\u200b\u200d\u00ad'], ['😀'], ['!!! ??? ###'], ['\u0301'], [' / \\ , _ ']])(
    'is false when the only name normalises to nothing: %j',
    (firstName) => {
      expect(hasScreenableName({ lastName: firstName, firstName, aliases: [firstName] })).toBe(false);
    },
  );

  it('is true when at least one variant (last name, first name or an alias) survives normalisation', () => {
    expect(hasScreenableName({ lastName: '---', firstName: '...', aliases: ['\u200b', 'Bat'] })).toBe(true);
    expect(hasScreenableName({ lastName: 'Бат', firstName: '---', aliases: [] })).toBe(true);
  });

  it('is false for a subject with no names at all', () => {
    expect(hasScreenableName({ firstName: '', aliases: [] })).toBe(false);
    expect(hasScreenableName({ lastName: ' ', firstName: ' ', aliases: [' '] })).toBe(false);
  });
});

describe('yearOf', () => {
  it.each([['1980', 1980], ['1980-05-01', 1980], [' 1975 ', 1975], ['80', null], ['1980-5-1', null], ['', null]] as const)('%j -> %s', (input, year) => {
    expect(yearOf(input)).toBe(year);
  });
});
