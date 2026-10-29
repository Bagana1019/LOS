import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findNulPath, findUnsafeString, PathParam, ZodPipe } from './zod.pipe';

const NUL = '\u0000';
const issuesOf = (fn: () => unknown) => {
  try { fn(); } catch (e) { return ((e as BadRequestException).getResponse() as { issues: { path: unknown[]; message: string }[] }).issues; }
  throw new Error('expected a BadRequestException');
};

describe('findNulPath', () => {
  it('finds a NUL in a string, nested object, array item or key and reports where', () => {
    expect(findNulPath(`a${NUL}b`)).toEqual([]);
    expect(findNulPath({ a: { b: ['x', `y${NUL}`] } })).toEqual(['a', 'b', 1]);
    expect(findNulPath({ [`k${NUL}`]: 1 })).toEqual(['k\\u0000']);
  });

  it('returns null for clean values, other control characters and non-strings', () => {
    expect(findNulPath({ a: ['x\u0001y', 1, null, undefined, true, { b: 'ok' }] })).toBeNull();
    expect(findNulPath(undefined)).toBeNull();
    expect(findNulPath('')).toBeNull();
  });

  it('does not overflow the stack on extremely deep nesting', () => {
    let deep: unknown = `x${NUL}`;
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(findNulPath(deep)).toHaveLength(200_000);
  });
});

describe('findUnsafeString (NUL and lone surrogates)', () => {
  const LONE_HIGH = '\ud800';
  const LONE_LOW = '\udc00';

  it.each([
    ['a lone high surrogate at the end', `Бат${LONE_HIGH}`],
    ['a lone low surrogate in the middle', `a${LONE_LOW}z`],
    ['a high surrogate followed by an ordinary character', `a${LONE_HIGH}z`],
    ['two high surrogates in a row', `${LONE_HIGH}${LONE_HIGH}`],
    ['a reversed pair (low, then high)', '\udc00\ud800'],
  ])('flags %s in a value and names the path', (_name, bad) => {
    expect(findUnsafeString({ subject: { aliases: ['ok', bad] } })).toEqual({ path: ['subject', 'aliases', 1], kind: 'UNICODE' });
    expect(findUnsafeString(bad)).toEqual({ path: [], kind: 'UNICODE' });
  });

  it('flags a lone surrogate in a key and reports the key in an escaped, well-formed form', () => {
    const found = findUnsafeString({ outer: { [`k${LONE_HIGH}`]: 1 } });
    expect(found).toEqual({ path: ['outer', 'k\\ud800'], kind: 'UNICODE' });
    expect(JSON.stringify(found)).toContain('k\\\\ud800');
  });

  it('accepts well-formed text: astral characters (emoji, valid pairs), Cyrillic and other control characters', () => {
    expect(findUnsafeString({ a: 'Бат-Эрдэнэ 😀 𝒜 \ud83d\ude00', b: ['x\u0001y', 1, null], '😀': 'ok' })).toBeNull();
  });

  it('reports NUL as kind NUL (and findNulPath ignores lone surrogates)', () => {
    expect(findUnsafeString({ a: `x${NUL}` })).toEqual({ path: ['a'], kind: 'NUL' });
    expect(findNulPath({ a: LONE_HIGH })).toBeNull();
    expect(findNulPath({ a: `x${NUL}` })).toEqual(['a']);
  });
});

describe('ZodPipe', () => {
  const pipe = new ZodPipe(z.object({ name: z.string().min(1), tags: z.array(z.string()).default([]) }));

  it('parses valid input and applies schema defaults', () => {
    expect(pipe.transform({ name: 'ok' })).toEqual({ name: 'ok', tags: [] });
  });

  it('answers 400 with the schema issues', () => {
    expect(issuesOf(() => pipe.transform({ name: '' }))[0]?.path).toEqual(['name']);
  });

  it('answers 400 for a NUL before the schema runs, naming the path but not echoing the value', () => {
    const issues = issuesOf(() => pipe.transform({ name: 'ok', tags: ['a', `b${NUL}c`] }));
    expect(issues).toEqual([{ code: 'custom', path: ['tags', 1], message: 'NUL (U+0000) characters are not allowed' }]);
  });

  it('answers 400 for a lone surrogate in a value or key (it would fail in the Prisma query engine as a 500), without echoing the value', () => {
    const inValue = issuesOf(() => pipe.transform({ name: 'ok', tags: ['a', 'b\ud800c'] }));
    expect(inValue).toEqual([{ code: 'custom', path: ['tags', 1], message: 'Invalid Unicode (lone surrogate) is not allowed' }]);
    expect(issuesOf(() => pipe.transform({ name: 'ok', ['k\udc00']: 1 }))[0]).toMatchObject({ path: ['k\\udc00'], message: 'Invalid Unicode (lone surrogate) is not allowed' });
    expect(JSON.stringify(inValue)).not.toContain('ud800');
  });

  it('PathParam accepts a plain string and rejects empty and NUL-containing ones with 400', () => {
    expect(PathParam.transform('cust-1')).toBe('cust-1');
    expect(() => PathParam.transform('')).toThrow(BadRequestException);
    expect(() => PathParam.transform(`a${NUL}b`)).toThrow(BadRequestException);
    expect(() => PathParam.transform('a\ud83dz')).toThrow(BadRequestException);
    expect(() => PathParam.transform(undefined)).toThrow(BadRequestException);
  });
});
