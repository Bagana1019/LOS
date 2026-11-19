import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  CUSTOMER_ACTION_UPDATE, CUSTOMER_TARGET_TYPE, CreateCustomerRequest, CustomerEditRequestBody, CustomerType, UpdateCustomerRequest, XypCitizenRequest, XypOtpRequest, type RequestContext,
} from '@los/contracts';
import { Ctx, DomainError, Permissions, ZodValidationPipe } from '@los/nest-common';
import { z } from 'zod';
import { actorFrom } from '../maker-checker/actor';
import { MakerCheckerService } from '../maker-checker/maker-checker.service';
import { CustomerService } from './customer.service';

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  registerNo: z.string().trim().max(32).optional(),
  customerType: z.enum(CustomerType).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
/** PUT/засварын хүсэлтэд `""` илгээсэн талбарууд = «арилгах» */
const clearedFields = (raw: unknown) =>
  Object.entries((raw ?? {}) as Record<string, unknown>).filter(([k, v]) => k in UpdateCustomerRequest.shape && typeof v === 'string' && v.trim() === '').map(([k]) => k);
/** Шууд өөрчлөх боломжгүй (регистр, төрөл) — өмнө нь чимээгүй хасагддаг байсан (M5) */
const READONLY_FIELDS = ['customerType', 'registerNo'] as const;
/** M5: PUT/засварын хүсэлтэд мэдэгдэхгүй эсвэл зөвхөн-унших талбар байвал 400 — юуг ч чимээгүй хаяхгүй. */
function assertWritableFields(raw: unknown): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return; // хэлбэр буруу бол zod 400 өгнө
  const keys = Object.keys(raw);
  const readonly = keys.filter((k) => (READONLY_FIELDS as readonly string[]).includes(k)).sort();
  const unknown = keys.filter((k) => !(k in UpdateCustomerRequest.shape) && !readonly.includes(k)).sort();
  if (unknown.length) throw new DomainError('UNKNOWN_FIELD', `Танигдахгүй талбар: ${unknown.join(', ')}`, 400, { fields: unknown });
  if (readonly.length) throw new DomainError('READONLY_FIELD', 'Регистр болон харилцагчийн төрлийг засах боломжгүй', 400, { fields: readonly });
}
const LookupQuery = z.object({ registerNo: z.string().trim().min(1, 'Регистр оруулна уу').max(32) });

/** Модуль 1 · Харилцагч. Унших — `customer:read`; үүсгэх/засах/ХУР — `customer:write` (ЗЭЗ). */
@Controller('customers')
export class CustomerController {
  constructor(private readonly customers: CustomerService, private readonly makerChecker: MakerCheckerService) {}

  @Permissions('customer:read') @Get()
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(ListQuery)) q: z.infer<typeof ListQuery>) { return this.customers.list(ctx, q); }

  @Permissions('customer:read') @Get('lookup')
  lookup(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(LookupQuery)) q: z.infer<typeof LookupQuery>) { return this.customers.lookup(ctx, q.registerNo); }

  /** FR-2.2 · иргэний зөвшөөрөл, 1-р алхам: ХУР иргэний БҮРТГЭЛТЭЙ утсанд нэг удаагийн код илгээнэ. Утасны дугаар хүлээн авахгүй (strict → 400). */
  @Permissions('customer:write') @HttpCode(200) @Post('xyp-otp')
  xypOtp(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(XypOtpRequest)) body: z.infer<typeof XypOtpRequest>) { return this.customers.xypRequestOtp(ctx, body.registerNo); }

  /** FR-2.2 · 2-р алхам: иргэний кодоор ХУР-аас татаж маягтыг бөглөнө. Хариуны `snapshotToken`-ийг `POST /customers`-д (`source=XYP`) буцааж өгнө. */
  @Permissions('customer:write') @HttpCode(200) @Post('xyp-fetch')
  xypFetch(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(XypCitizenRequest)) body: z.infer<typeof XypCitizenRequest>) { return this.customers.xypFetch(ctx, body.registerNo, body.otp); }

  @Permissions('customer:write') @Post()
  create(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(CreateCustomerRequest)) body: CreateCustomerRequest) { return this.customers.create(ctx, body); }

  @Permissions('customer:read') @Get(':id')
  card(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) { return this.customers.card(ctx, id); }

  /** `""` (хоосон мөр) = талбарыг арилгах: заавал талбар бол 400 «Заавал бөглөнө», заавал биш бол цэвэрлэгдэнэ. Талбарыг огт өгөхгүй бол өөрчлөгдөхгүй. */
  @Permissions('customer:write') @Put(':id')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() raw: unknown) {
    assertWritableFields(raw);
    return this.customers.update(ctx, id, UpdateCustomerRequest.parse(raw), clearedFields(raw));
  }

  /**
   * Эзэмшигч бус салбарын засварын хүсэлт (maker-checker CUSTOMER/UPDATE, шийдвэр 2026-11-18 хувилбар A): 202 PENDING — эзэмшигч салбарын захирал батална.
   * `changes` нь PUT-ийн бие (ижил шалгалт, `""` = арилгах); өгөгдөл батлагдах хүртэл өөрчлөгдөхгүй.
   */
  @Permissions('customer:write') @HttpCode(202) @Post(':id/edit-requests')
  submitEdit(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(CustomerEditRequestBody)) body: CustomerEditRequestBody) {
    assertWritableFields(body.changes);
    const changes = UpdateCustomerRequest.parse(body.changes);
    return this.makerChecker.submit(actorFrom(ctx), {
      targetType: CUSTOMER_TARGET_TYPE, action: CUSTOMER_ACTION_UPDATE, targetId: id, payload: { changes, cleared: clearedFields(body.changes) }, reason: body.reason,
    });
  }
}
