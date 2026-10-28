import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { PortalError } from './portal-error';

/** @Body/@Param/@Query-г zod схемээр шалгаж, алдааг нэг загвараар (INVALID_REQUEST) буцаана. */
@Injectable()
export class ZodPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new PortalError(
      'INVALID_REQUEST',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
}
