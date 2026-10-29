import { expect } from 'vitest';
import type { ZodTypeAny, z } from 'zod';

/** Хариу @los/contracts-ын zod схемд таарч байгааг шалгаад parse хийсэн утгыг буцаана. */
export function parseWith<T extends ZodTypeAny>(schema: T, body: unknown, label = 'response'): z.output<T> {
  const r = schema.safeParse(body);
  expect(r.success, `${label} does not match the contract: ${r.success ? '' : JSON.stringify(r.error.issues)}`).toBe(true);
  return (r as { data: z.output<T> }).data;
}
