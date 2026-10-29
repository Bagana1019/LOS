// Service-ийн оролтыг zod-оор давхар шалгах (controller шалгасан ч service нь өөр модулиас шууд дуудагдаж болно).
// Алдааны мэдээлэлд зөвхөн замууд + zod кодууд (оруулсан УТГА орохгүй — PII).
import type { z } from 'zod';
import { badRequest } from './import.errors';

export function parseInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw badRequest('INVALID_REQUEST', { issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`) });
  }
  return parsed.data;
}
