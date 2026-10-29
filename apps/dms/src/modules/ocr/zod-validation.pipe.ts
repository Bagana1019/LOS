// Энэ модульд л хэрэглэх жижиг zod pipe. Алдааны хариунд зөвхөн замыг ба zod-ийн кодыг оруулна —
// ирсэн утгыг (received) эргүүлж харуулахгүй (хэрэглэгчийн оролт log/хариунд тусахаас сэргийлнэ).
import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'VALIDATION_FAILED',
      message: 'Хүсэлтийн талбар буруу байна',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
    });
  }
}
