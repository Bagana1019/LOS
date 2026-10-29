import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PathParam, ZodPipe, assertCleanText, findUnsafeText, safeIssues, unsafeTextMessage } from './zod.pipe';

const REGISTER = 'УБ12345678';

describe('unsafeTextMessage', () => {
  it.each([
    ['NUL', 'a\u0000b', 'NUL (U+0000) characters are not allowed'],
    ['the replacement character', 'Бат\uFFFDБолд', 'U+FFFD replacement characters are not allowed (the text was not valid UTF-8)'],
    ['a lone high surrogate', 'Бат\ud800', 'invalid Unicode (lone surrogate) is not allowed'],
    ['a lone low surrogate', '\udc00', 'invalid Unicode (lone surrogate) is not allowed'],
    ['a high surrogate followed by a non-surrogate', 'a\ud83dz', 'invalid Unicode (lone surrogate) is not allowed'],
    ['a reversed pair', '\ude00\ud83d', 'invalid Unicode (lone surrogate) is not allowed'],
  ])('flags %s without echoing the text', (_label, text, message) => {
    expect(unsafeTextMessage(text)).toBe(message);
  });

  it.each(['', 'Бат Болд', REGISTER, '😀', 'a😀b', '\u{10FFFF}', '◆ ? \u200B \u00A0'])('accepts %j', (text) => {
    expect(unsafeTextMessage(text)).toBeNull();
  });

  // Node 22 дээрх String.prototype.isWellFormed()-тэй яг ижил (ES2024 typings-гүй орчинд regex ашигладаг).
  it('agrees with String.prototype.isWellFormed on a table of well- and ill-formed strings', () => {
    const samples = ['', 'a', '😀', '\ud800', '\udc00', 'a\ud800b', '\ud800\udc00', '\ud800\ud800\udc00', '\udc00\ud800', 'x\ud83d', '\ud83dx😀', '\uFFFD'];
    for (const s of samples) {
      const wellFormed = (s as unknown as { isWellFormed(): boolean }).isWellFormed();
      expect(unsafeTextMessage(s) === 'invalid Unicode (lone surrogate) is not allowed', JSON.stringify(s)).toBe(!wellFormed);
    }
  });
});

describe('findUnsafeText', () => {
  it('returns the path of the first offending value, through arrays and nested objects', () => {
    expect(findUnsafeText({ rows: [{ name: 'ok' }, { name: 'Бат\ud800' }] })).toEqual({
      path: ['rows', 1, 'name'],
      message: 'invalid Unicode (lone surrogate) is not allowed',
    });
    expect(findUnsafeText(['ok', 'a\uFFFD'])?.path).toEqual([1]);
    expect(findUnsafeText('a\u0000')?.path).toEqual([]);
  });

  it('finds a hostile object key, reports the parent path and never echoes the key', () => {
    for (const key of ['na\u0000me', `${REGISTER}\ud800`, `${REGISTER}\uFFFD`]) {
      const found = findUnsafeText({ rows: [{ [key]: 'x' }] });
      expect(found?.path).toEqual(['rows', 0]);
      expect(found?.message).toMatch(/ \(in an object key\)$/);
      expect(JSON.stringify(found)).not.toContain(REGISTER);
    }
  });

  it('returns null for clean input, valid surrogate pairs and non-string leaves', () => {
    expect(findUnsafeText({ a: ['😀', 1, true, null, undefined], b: { 'ключ': 'Бат' } })).toBeNull();
  });

  it('does not overflow the stack on deeply nested input (iterative)', () => {
    let deep: unknown = 'x\uFFFD';
    for (let i = 0; i < 50_000; i++) deep = [deep];
    expect(findUnsafeText(deep)?.path).toHaveLength(50_000);
  });
});

describe('assertCleanText', () => {
  const capture = (value: unknown, hint?: string) => {
    try {
      assertCleanText(value, hint);
    } catch (e) {
      return e as BadRequestException;
    }
    return null;
  };

  it('throws a 400 with the custom issue shape for every unsafe class, and appends the hint', () => {
    for (const text of ['a\u0000', 'a\uFFFD', 'a\ud800']) {
      const err = capture({ name: text }, ' (the file must be UTF-8 text)');
      expect(err).toBeInstanceOf(BadRequestException);
      const body = err?.getResponse() as { statusCode: number; message: string; issues: Array<{ code: string; path: unknown[]; message: string }> };
      expect(body).toMatchObject({ statusCode: 400, message: 'Validation failed', issues: [{ code: 'custom', path: ['name'] }] });
      expect(body.issues[0].message).toMatch(/ \(the file must be UTF-8 text\)$/);
    }
  });

  it('does nothing for clean values', () => {
    expect(capture({ name: 'Бат 😀' })).toBeNull();
  });
});

describe('safeIssues / ZodPipe', () => {
  const schema = z.object({
    customerType: z.enum(['INDIVIDUAL', 'LEGAL_ENTITY']),
    name: z.string().min(1).max(5),
    age: z.number().int().min(18),
    kind: z.literal('A'),
    code: z.string().regex(/^[A-Z]+$/),
  }).strict();
  const issuesFor = (input: unknown) => {
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error('expected a failure');
    return safeIssues(parsed.error);
  };

  it('never carries the received value, in the message or in any other field', () => {
    const issues = issuesFor({ customerType: REGISTER, name: `${REGISTER}-too-long`, age: '30', kind: REGISTER, code: REGISTER.toLowerCase(), [`${REGISTER}x`]: 1 });
    const json = JSON.stringify(issues);

    expect(json).not.toContain(REGISTER);
    expect(json).not.toContain(REGISTER.toLowerCase());
    expect(json).not.toContain('received');
    expect(issues.find((i) => i.path[0] === 'customerType')).toEqual({
      code: 'invalid_enum_value', path: ['customerType'], message: "Invalid enum value. Expected 'INDIVIDUAL' | 'LEGAL_ENTITY'", options: ['INDIVIDUAL', 'LEGAL_ENTITY'],
    });
    expect(issues.find((i) => i.path[0] === 'age')).toEqual({ code: 'invalid_type', path: ['age'], message: 'Expected number', expected: 'number' });
    expect(issues.find((i) => i.path[0] === 'kind')).toMatchObject({ code: 'invalid_literal', message: 'Invalid literal value. Expected "A"' });
    expect(issues.find((i) => i.code === 'unrecognized_keys')).toMatchObject({ message: 'Unrecognized key(s) in object (1)' });
  });

  it('says Required for a missing value and keeps the schema-derived size and format messages', () => {
    const issues = issuesFor({ name: '', age: 3, code: 'abc' });
    expect(issues.find((i) => i.path[0] === 'customerType')?.message).toBe('Required');
    expect(issues.find((i) => i.path[0] === 'name')?.message).toBe('String must contain at least 1 character(s)');
    expect(issues.find((i) => i.path[0] === 'age')?.message).toBe('Number must be greater than or equal to 18');
    expect(issues.find((i) => i.path[0] === 'code')?.code).toBe('invalid_string');
  });

  it('maps codes it does not know to a fixed message', () => {
    const union = z.union([z.string(), z.number()]).safeParse(true);
    if (union.success) throw new Error('expected a failure');
    expect(safeIssues(union.error)).toEqual([{ code: 'invalid_union', path: [], message: 'Invalid input' }]);
  });

  it('answers a ZodPipe failure with 400 {statusCode, message, issues} that holds neither the value nor a stack', () => {
    const pipe = new ZodPipe(schema);
    let thrown: unknown;
    try {
      pipe.transform({ customerType: REGISTER });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    const text = JSON.stringify((thrown as BadRequestException).getResponse());
    expect(text).toContain('Validation failed');
    expect(text).not.toContain(REGISTER);
    expect(text).not.toMatch(/received|stack/);
  });

  it('screens for unsafe text before the schema runs, so the offending value is never validated or echoed', () => {
    const pipe = new ZodPipe(z.object({ name: z.string() }));
    for (const name of ['a\u0000', 'a\uFFFD', 'a\ud800']) {
      expect(() => pipe.transform({ name })).toThrow(BadRequestException);
    }
    expect(pipe.transform({ name: 'Бат 😀' })).toEqual({ name: 'Бат 😀' });
  });

  it('PathParam accepts a non-empty clean string and rejects empty, non-string and unsafe text', () => {
    expect(PathParam.transform('abc')).toBe('abc');
    for (const bad of ['', 5, 'a\u0000', 'a\uFFFD', 'a\ud800']) expect(() => PathParam.transform(bad)).toThrow(BadRequestException);
  });
});
