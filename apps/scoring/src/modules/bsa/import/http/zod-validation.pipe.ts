// Controller-ийн локал zod pipe: body / query / param бүрийг @los/contracts-ийн схемээр шалгана. Алдааны хариунд ЗӨВХӨН зам + zod код орно —
// ирсэн УТГА (регистр, дансны дугаар, хайлтын текст гэх мэт PII) хэзээ ч буцахгүй, лог руу ч орохгүй.
import { HttpStatus, type PipeTransform } from '@nestjs/common';
import type { ZodTypeAny, z } from 'zod';
import { BsaException } from '../import.errors';

export interface ValidationIssue {
  path: string;
  code: string;
}

/** 400 VALIDATION_FAILED. `issues` нь хариуны дээд түвшинд гарна (BsaApiError.issues) */
export class BsaValidationException extends BsaException {
  constructor(readonly issues: ValidationIssue[]) {
    super(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');
  }
}

/** Нэг хүсэлтэд хэт олон issue буцаахгүй (хариуны хэмжээ) */
const MAX_ISSUES = 20;

export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new BsaValidationException(parsed.error.issues.slice(0, MAX_ISSUES).map((i) => ({ path: i.path.join('.'), code: i.code })));
  }
}
