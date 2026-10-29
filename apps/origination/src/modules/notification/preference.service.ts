import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { NotificationChannel, NotificationPreferenceRequest, NotificationPreferenceView, RecipientType } from '@los/contracts';
import { PrismaService } from '../../prisma.service';
import { hasRole } from '../../shared/roles';
import type { RequestContext } from '@los/contracts';

/** Хүлээн авагчийн төрлөөр хамаарах суваг: зээлдэгч SMS/EMAIL/PUSH, ажилтан зөвхөн хонх (IN_APP). */
export const APPLICABLE_CHANNELS: Record<RecipientType, readonly NotificationChannel[]> = {
  CUSTOMER: ['SMS', 'EMAIL', 'PUSH'],
  USER: ['IN_APP'],
};

/** FR-13.2: суваг тус бүрийн opt-out (NotificationPreference). Анхдагч — идэвхтэй. */
@Injectable()
export class PreferenceService {
  constructor(private readonly prisma: PrismaService) {}

  async get(ctx: RequestContext, recipientType: RecipientType, recipientId: string): Promise<NotificationPreferenceView> {
    await this.assertAccess(ctx, recipientType, recipientId);
    return this.view(ctx.orgId, recipientType, recipientId);
  }

  async put(ctx: RequestContext, recipientType: RecipientType, recipientId: string, dto: NotificationPreferenceRequest): Promise<NotificationPreferenceView> {
    await this.assertAccess(ctx, recipientType, recipientId);
    const allowed = APPLICABLE_CHANNELS[recipientType];
    const bad = dto.channels.filter((c) => !allowed.includes(c.channel)).map((c) => c.channel);
    if (bad.length) {
      throw new BadRequestException({ code: 'CHANNEL_NOT_APPLICABLE', message: `Энэ хүлээн авагчид ${bad.join(', ')} суваг хамаарахгүй (боломжит: ${allowed.join(', ')})` });
    }
    const latest = new Map(dto.channels.map((c) => [c.channel, c.enabled])); // давхардвал сүүлийнх
    for (const [channel, enabled] of latest) {
      // Бүх асуулга ctx.orgId-аар хязгаарлагдана: өөр байгууллагын тохиргоог уншиж/бичиж/дарж чадахгүй (unique нь orgId-тэй).
      const where = { orgId: ctx.orgId, subjectType: recipientType, subjectId: recipientId, channel };
      // Зэрэгцээ PUT-д unique зөрчил гаргахгүйн тулд: update → (байхгүй бол) createMany(skipDuplicates) → update.
      const first = await this.prisma.notificationPreference.updateMany({ where, data: { enabled } });
      if (first.count === 0) {
        await this.prisma.notificationPreference.createMany({ data: [{ ...where, enabled }], skipDuplicates: true });
        await this.prisma.notificationPreference.updateMany({ where, data: { enabled } });
      }
    }
    return this.view(ctx.orgId, recipientType, recipientId);
  }

  private async view(orgId: string, recipientType: RecipientType, recipientId: string): Promise<NotificationPreferenceView> {
    const rows = await this.prisma.notificationPreference.findMany({ where: { orgId, subjectType: recipientType, subjectId: recipientId } });
    const state = new Map(rows.map((r) => [r.channel, r.enabled]));
    return { recipientType, recipientId, channels: APPLICABLE_CHANNELS[recipientType].map((channel) => ({ channel, enabled: state.get(channel) ?? true })) };
  }

  /**
   * CUSTOMER дүр — зөвхөн өөрөө; ADMIN — бүгд; OFFICER — өөрийн хариуцсан хүсэлтийн PRIMARY/CO_BORROWER зээлдэгчийн өмнөөс;
   * ажилтны (USER) тохиргоог зөвхөн тухайн ажилтан өөрөө (эсвэл ADMIN).
   * Ажилтан (iam схем) нь origination-д байхгүй тул USER-ийн org-д харьяалагдахыг шалгах боломжгүй; үүний оронд мөр бүр `ctx.orgId`-д хамаарах тул
   * өөр org-ийн ADMIN зөвхөн өөрийн org-ийн мөрийг үүсгэж/уншиж чадна — өөр org-ийн мэдэгдэлд нөлөөлөхгүй.
   */
  private async assertAccess(ctx: RequestContext, recipientType: RecipientType, recipientId: string): Promise<void> {
    const deny = () => new ForbiddenException({ code: 'FORBIDDEN', message: 'Энэ хүлээн авагчийн мэдэгдлийн тохиргоонд хандах эрхгүй' });
    if (recipientType === 'USER') {
      if (hasRole(ctx, 'ADMIN') || (ctx.userId && ctx.userId === recipientId)) return;
      throw deny();
    }
    if (hasRole(ctx, 'CUSTOMER') && !hasRole(ctx, 'ADMIN')) {
      if (ctx.customerId && ctx.customerId === recipientId) return;
      throw deny();
    }
    const customer = await this.prisma.customer.findFirst({ where: { id: recipientId, orgId: ctx.orgId }, select: { id: true } });
    if (hasRole(ctx, 'ADMIN')) {
      if (!customer) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND', message: 'Харилцагч олдсонгүй' });
      return;
    }
    if (hasRole(ctx, 'OFFICER') && ctx.userId) {
      const link = await this.prisma.loanApplicationBorrower.findFirst({
        where: { customerId: recipientId, orgId: ctx.orgId, role: { in: ['PRIMARY', 'CO_BORROWER'] }, application: { officerId: ctx.userId } }, select: { id: true },
      });
      if (link) return;
    }
    throw deny();
  }
}
