import { randomUUID } from 'node:crypto';
import { ForbiddenException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { DeliveryListQuery, DeliveryListResponse, DeliveryView, SendTestRequest } from '@los/contracts';
import { Clock } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { hasRole } from '../../shared/roles';
import type { RequestContext } from '@los/contracts';
import { DeliveryProcessor } from './delivery.processor';
import { toDeliveryView } from './notification.mapper';
import { normalizeEmail, normalizeMnPhone } from './phone';
import { SAMPLE_VARS, TemplateService } from './template.service';

/** Хүргэлтийн бүртгэл харах (ADMIN, BRANCH_MANAGER) ба туршилтын мессеж илгээх (ADMIN). */
@Injectable()
export class DeliveryAdminService {
  constructor(private readonly prisma: PrismaService, private readonly clock: Clock, private readonly templates: TemplateService, private readonly processor: DeliveryProcessor) {}

  /** ADMIN — байгууллагын бүгд; BRANCH_MANAGER — зөвхөн өөрийн салбарын хүсэлтийн хүргэлт. */
  async list(ctx: RequestContext, query: DeliveryListQuery): Promise<DeliveryListResponse> {
    const admin = hasRole(ctx, 'ADMIN');
    if (!admin && !ctx.branchId) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Салбар тодорхойгүй тул хүргэлтийн бүртгэл харах эрхгүй' });
    const where = {
      orgId: ctx.orgId, ...(admin ? {} : { branchId: ctx.branchId }),
      ...(query.applicationId ? { applicationId: query.applicationId } : {}), ...(query.status ? { status: query.status } : {}), ...(query.channel ? { channel: query.channel } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.notificationDelivery.findMany({ where, orderBy: [{ scheduledFor: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.notificationDelivery.count({ where }),
    ]);
    return { items: rows.map(toDeliveryView), total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * Сонгосон сувгаар ганц туршилтын мессеж: загварыг жишээ утгаар render хийж, delivery бүртгээд queue-г тойроод gateway руу шууд илгээнэ.
   * Хариу нь боловсруулсны дараах хүргэлт (SENT / дахин оролдлого хүлээж буй QUEUED / FAILED).
   */
  async testSend(ctx: RequestContext, dto: SendTestRequest): Promise<DeliveryView> {
    if (dto.channel === 'IN_APP') throw new UnprocessableEntityException({ code: 'CHANNEL_NOT_TESTABLE', message: 'Хонхны (IN_APP) мэдэгдлийг туршилтаар илгээх боломжгүй' });
    const to = dto.channel === 'SMS' ? normalizeMnPhone(dto.to) : dto.channel === 'EMAIL' ? normalizeEmail(dto.to) : dto.to.trim().length >= 8 ? dto.to.trim() : null;
    if (!to) throw new UnprocessableEntityException({ code: 'INVALID_ADDRESS', message: dto.channel === 'SMS' ? 'Утасны дугаар буруу (8 оронтой монгол дугаар)' : dto.channel === 'EMAIL' ? 'Имэйл хаяг буруу' : 'Push токен буруу' });
    const message = await this.templates.render(ctx.orgId, dto.type, dto.channel, 'mn', SAMPLE_VARS);
    if (!message) throw new UnprocessableEntityException({ code: 'TEMPLATE_NOT_FOUND', message: 'Энэ төрөл, сувгийн загвар байхгүй байна' });
    const now = this.clock.now();
    const marker = '[Туршилт] ';
    const row = await this.prisma.notificationDelivery.create({
      data: {
        orgId: ctx.orgId, type: dto.type, channel: dto.channel, recipientType: 'USER', recipientId: ctx.userId ?? 'unknown', address: to,
        subject: message.subject ? marker + message.subject : null, body: message.subject ? message.body : marker + message.body,
        payloadJson: { test: true }, dedupeKey: `test:${randomUUID()}`, status: 'QUEUED', nextAttemptAt: now, scheduledFor: now,
      },
    });
    await this.processor.process(row.id);
    return toDeliveryView(await this.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: row.id } }));
  }
}
