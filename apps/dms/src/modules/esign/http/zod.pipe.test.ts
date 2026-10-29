import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodPipe } from './zod.pipe';

describe('ZodPipe', () => {
  const pipe = new ZodPipe(z.object({ n: z.coerce.number().int(), tag: z.string().default('x') }));

  it('схемийн задалсан утгыг (coerce, default) буцаана', () => {
    expect(pipe.transform({ n: '3' })).toEqual({ n: 3, tag: 'x' });
  });

  it('буруу бол ZodError шиднэ (filter 400 болгоно)', () => {
    expect(() => pipe.transform({ n: 'abc' })).toThrow(z.ZodError);
    expect(() => pipe.transform(undefined)).toThrow(z.ZodError);
  });
});
