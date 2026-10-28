import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z, ZodTypeAny } from 'zod';

/** Validates with a zod schema and hands the PARSED value to the handler (e.g. the plate number is already normalised). */
export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'The request is invalid. See issues for the fields to correct.',
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
}
