// FR-11.4 zod схемээр биеийг/query-г шалгана. Алдаа `ZodError` хэвээр шидэгдэж, signing-exception.filter.ts 400 болгоно (утгыг дахин харуулахгүй).
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    return this.schema.parse(value);
  }
}
