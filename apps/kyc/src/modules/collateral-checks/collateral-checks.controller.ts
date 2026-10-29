import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { EncumbranceCheckRequest, type EncumbranceCheckResult } from '@los/contracts';
import { Permissions, ZodValidationPipe } from '@los/nest-common';
import { z } from 'zod';
import { CollateralChecksService } from './collateral-checks.service';

/** FR-6.6 · ачаалал шалгах (ЗМС + ЭБ). Дуудагч: origination. Хөрөнгийн дугаарыг лог-д бичихгүй. */
@Controller('collateral-checks')
export class CollateralChecksController {
  constructor(private readonly checks: CollateralChecksService) {}

  @Permissions('customer:read')
  @HttpCode(200)
  @Post('encumbrance')
  encumbrance(@Body(new ZodValidationPipe(EncumbranceCheckRequest)) body: z.infer<typeof EncumbranceCheckRequest>): Promise<EncumbranceCheckResult> {
    return this.checks.checkEncumbrance(body);
  }
}
