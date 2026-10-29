import type { PipeTransform } from '@nestjs/common';
import type { ZodError, ZodIssue, ZodTypeAny, z } from 'zod';
import { DomainError } from '../domain/errors';
import { scrubPii } from './masking';

export interface ValidationIssue { path: string; message: string }

export function toIssues(issues: ZodIssue[]): ValidationIssue[] {
  return issues.map((i) => ({ path: i.path.join('.'), message: scrubPii(i.message) }));
}

export function validationFailed(error: ZodError | ZodIssue[], message = 'Validation failed'): DomainError {
  const issues = Array.isArray(error) ? error : error.issues;
  return new DomainError('VALIDATION_FAILED', message, { issues: toIssues(issues) });
}

/** Body/query-г @los/contracts-ын zod схемээр шалгана (docs/05 §8). Алдаа → 400 VALIDATION_FAILED + details.issues. */
export class ZodPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) throw validationFailed(result.error);
    return result.data;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path-ийн :id буруу хэлбэртэй бол оршин байгааг задруулахгүйгээр 404. */
export class ParseIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !UUID_RE.test(value)) throw new DomainError('NOT_FOUND', 'Not found');
    return value;
  }
}
