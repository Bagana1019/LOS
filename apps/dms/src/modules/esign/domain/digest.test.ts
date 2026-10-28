import { describe, expect, it } from 'vitest';
import { sha256Hex, timingSafeEqualHex } from './digest';

const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256Hex', () => {
  it('string болон Buffer-д ижил, мэдэгдэж буй вектор', () => {
    expect(sha256Hex('abc')).toBe(ABC);
    expect(sha256Hex(Buffer.from('abc'))).toBe(ABC);
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('кирилл тексттэй UTF-8-аар', () => {
    expect(sha256Hex('Гэрээ')).toBe(sha256Hex(Buffer.from('Гэрээ', 'utf8')));
  });
});

describe('timingSafeEqualHex', () => {
  it('ижил, том/жижиг үсэг ялгахгүй', () => {
    expect(timingSafeEqualHex(ABC, ABC)).toBe(true);
    expect(timingSafeEqualHex(ABC, ABC.toUpperCase())).toBe(true);
  });

  it('нэг тэмдэгт ялгаатай (эхэнд, төгсгөлд), эсвэл урт ялгаатай бол false', () => {
    expect(timingSafeEqualHex(ABC, `0${ABC.slice(1)}`)).toBe(false);
    expect(timingSafeEqualHex(ABC, `${ABC.slice(0, -1)}0`)).toBe(false);
    expect(timingSafeEqualHex(ABC, ABC.slice(1))).toBe(false);
    expect(timingSafeEqualHex(ABC, `${ABC}0`)).toBe(false);
    expect(timingSafeEqualHex('', ABC)).toBe(false);
  });

  it('хоосон digest хэзээ ч тэнцүү гэж тооцогдохгүй (хоосон = хоосон ч false)', () => {
    expect(timingSafeEqualHex('', '')).toBe(false);
  });

  it('string биш утгыг (runtime-д) false', () => {
    expect(timingSafeEqualHex(undefined as unknown as string, ABC)).toBe(false);
    expect(timingSafeEqualHex(ABC, null as unknown as string)).toBe(false);
  });
});
