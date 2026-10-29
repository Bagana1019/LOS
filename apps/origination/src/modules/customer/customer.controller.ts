import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { CreateCustomerRequest, CustomerType, UpdateCustomerRequest, XypCitizenRequest, type RequestContext } from '@los/contracts';
import { Ctx, Permissions, ZodValidationPipe } from '@los/nest-common';
import { z } from 'zod';
import { CustomerService } from './customer.service';

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  registerNo: z.string().trim().max(32).optional(),
  customerType: z.enum(CustomerType).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const LookupQuery = z.object({ registerNo: z.string().trim().min(1, 'Регистр оруулна уу').max(32) });

/** Модуль 1 · Харилцагч. Унших — `customer:read`; үүсгэх/засах/ХУР — `customer:write` (ЗЭЗ). */
@Controller('customers')
export class CustomerController {
  constructor(private readonly customers: CustomerService) {}

  @Permissions('customer:read') @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(ListQuery)) q: z.infer<typeof ListQuery>) { return this.customers.list(ctx, q); }

  @Permissions('customer:read') @Get('lookup')
  lookup(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(LookupQuery)) q: z.infer<typeof LookupQuery>) { return this.customers.lookup(ctx, q.registerNo); }

  @Permissions('customer:write') @HttpCode(200) @Post('xyp-fetch')
  xypFetch(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(XypCitizenRequest)) body: z.infer<typeof XypCitizenRequest>) { return this.customers.xypFetch(ctx, body.registerNo); }

  @Permissions('customer:write') @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateCustomerRequest)) body: CreateCustomerRequest) { return this.customers.create(ctx, body); }

  @Permissions('customer:read') @Get(':id')
  card(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.customers.card(ctx, id); }

  /** `""` (хоосон мөр) = талбарыг арилгах: заавал талбар бол 400 «Заавал бөглөнө», заавал биш бол цэвэрлэгдэнэ. Талбарыг огт өгөхгүй бол өөрчлөгдөхгүй. */
  @Permissions('customer:write') @Put(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() raw: unknown) {
    const patch = UpdateCustomerRequest.parse(raw);
    const cleared = Object.entries((raw ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && v.trim() === '').map(([k]) => k);
    return this.customers.update(ctx, id, patch, cleared);
  }
}
