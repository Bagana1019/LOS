// ZodValidationPipe: зөв утга → задалсан утга; буруу утга → 400 VALIDATION_FAILED, зөвхөн зам + zod код (ирсэн утга хэзээ ч буцахгүй).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BsaValidationException, ZodValidationPipe } from './zod-validation.pipe';

const schema = z.object({ name: z.string().min(2), count: z.coerce.number().int().default(3), items: z.array(z.object({ qty: z.number() })).optional() }).strict();

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns the parsed value with defaults and coercion applied', () => {
    expect(pipe.transform({ name: 'ab' })).toEqual({ name: 'ab', count: 3 });
    expect(pipe.transform({ name: 'ab', count: '7' })).toEqual({ name: 'ab', count: 7 });
  });

  it('throws BsaValidationException (400, VALIDATION_FAILED) with dotted paths and zod codes only', () => {
    let error: unknown;
    try {
      pipe.transform({ name: 'x', items: [{ qty: 'zxq-secret' }], extra: 'zxq-secret' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BsaValidationException);
    const e = error as BsaValidationException;
    expect(e.getStatus()).toBe(400);
    expect(e.bsaCode).toBe('VALIDATION_FAILED');
    expect(e.issues).toEqual(
      expect.arrayContaining([
        { path: 'name', code: 'too_small' },
        { path: 'items.0.qty', code: 'invalid_type' },
        { path: '', code: 'unrecognized_keys' },
      ]),
    );
    expect(JSON.stringify(e.issues)).not.toContain('zxq-secret');
  });

  it('reports a non-object body as a root issue', () => {
    expect(() => pipe.transform(undefined)).toThrowError(BsaValidationException);
    try {
      pipe.transform('plain text');
    } catch (e) {
      expect((e as BsaValidationException).issues).toEqual([{ path: '', code: 'invalid_type' }]);
    }
  });

  it('caps the number of reported issues', () => {
    const many = new ZodValidationPipe(z.array(z.string()));
    try {
      many.transform(Array.from({ length: 100 }, () => 1));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as BsaValidationException).issues).toHaveLength(20);
    }
  });
});
