import { describe, expect, it } from 'vitest';
import { isObjectMissing, MemoryStorage } from './storage';

// F4-2: both drivers signal a missing object with `code: 'NoSuchKey'` (MemoryStorage; minio's S3Error copies the XML <Code>).
describe('isObjectMissing', () => {
  it('recognises the MemoryStorage miss', async () => {
    const miss = await new MemoryStorage().get('absent').catch((e: unknown) => e);
    expect(isObjectMissing(miss)).toBe(true);
  });

  it('recognises an S3-shaped NoSuchKey error (minio S3Error carries `code`)', () => {
    const s3 = Object.assign(new Error('The specified key does not exist.'), { code: 'NoSuchKey', region: 'us-east-1' });
    expect(isObjectMissing(s3)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'NoSuchKey'],
    ['a number', 404],
    ['an Error with the text only, no code', new Error('NoSuchKey')],
    ['a missing bucket', Object.assign(new Error('The specified bucket does not exist'), { code: 'NoSuchBucket' })],
    ['a refused connection', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['an empty object', {}],
  ])('does not match %s', (_label, value) => {
    expect(isObjectMissing(value)).toBe(false);
  });
});
