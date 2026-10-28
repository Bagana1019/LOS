import { Injectable, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { err } from './maker-checker.errors';

@Injectable()
export class ZodPipe<T extends z.ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    const r = this.schema.safeParse(value);
    if (!r.success) throw err('VALIDATION_FAILED', r.error.issues);
    return r.data;
  }
}
