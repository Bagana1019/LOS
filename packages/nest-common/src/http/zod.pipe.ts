import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';

/** `@Body(new ZodValidationPipe(Schema))` — алдаа нь AllExceptionsFilter-ээр 400 VALIDATION_FAILED болно. */
@Injectable()
export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}
  transform(value: unknown, _meta?: ArgumentMetadata): z.infer<S> {
    return this.schema.parse(value);
  }
}
