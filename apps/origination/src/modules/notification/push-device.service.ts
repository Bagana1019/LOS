import { randomUUID } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PushDeviceView, PushPlatform, RecipientType, RegisterPushDeviceRequest } from '@los/contracts';
import type { PushDevice } from '.prisma/client-origination';
import { Clock } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { hasRole } from '../../shared/roles';
import type { RequestContext } from '@los/contracts';
import { maskAddress } from '../../integrations/channel/channel-error';

export const toPushDeviceView = (d: PushDevice): PushDeviceView => ({
  id: d.id, ownerType: d.ownerType as RecipientType, ownerId: d.ownerId, platform: d.platform as PushPlatform, tokenMasked: maskAddress('PUSH', d.token) ?? '***',
  isActive: d.isActive, lastSeenAt: d.lastSeenAt.toISOString(),
});

/** Push төхөөрөмжийн токен бүртгэл. Хэрэглэгч зөвхөн өөрийнхийгөө: ажилтан → USER/өөрийн userId, CUSTOMER дүр → CUSTOMER/өөрийн customerId. */
@Injectable()
export class PushDeviceService {
  constructor(private readonly prisma: PrismaService, private readonly clock: Clock) {}

  /** Токен давтагдвал (шинэ нэвтрэлт, төхөөрөмж шилжсэн) эзэмшигч, платформ, lastSeenAt-ыг шинэчилж идэвхжүүлнэ. @returns created=false бол байсныг шинэчилсэн */
  async register(ctx: RequestContext, dto: RegisterPushDeviceRequest): Promise<{ view: PushDeviceView; created: boolean }> {
    this.assertOwner(ctx, dto.ownerType, dto.ownerId);
    const now = this.clock.now();
    const data = { orgId: ctx.orgId, ownerType: dto.ownerType, ownerId: dto.ownerId, platform: dto.platform, isActive: true, lastSeenAt: now };
    // update-first: зэрэгцээ бүртгэлд unique зөрчил гаргахгүй (байхгүй бол createMany skipDuplicates, дараа нь дахин update).
    const updated = await this.prisma.pushDevice.updateMany({ where: { token: dto.token }, data });
    let created = false;
    if (updated.count === 0) {
      const res = await this.prisma.pushDevice.createMany({ data: [{ id: randomUUID(), token: dto.token, ...data }], skipDuplicates: true });
      created = res.count === 1;
      if (!created) await this.prisma.pushDevice.updateMany({ where: { token: dto.token }, data });
    }
    const row = await this.prisma.pushDevice.findUniqueOrThrow({ where: { token: dto.token } });
    return { view: toPushDeviceView(row), created };
  }

  /** Эзэмшигч л устгана; бусдынх/байхгүй → 404 (токены оршихуйг задруулахгүй). */
  async remove(ctx: RequestContext, token: string): Promise<void> {
    const own = this.ownerOf(ctx);
    const res = own
      ? await this.prisma.pushDevice.deleteMany({ where: { token, orgId: ctx.orgId, ownerType: own.type, ownerId: own.id } })
      : { count: 0 };
    if (res.count === 0) throw new NotFoundException({ code: 'PUSH_DEVICE_NOT_FOUND', message: 'Төхөөрөмж олдсонгүй' });
  }

  private ownerOf(ctx: RequestContext): { type: RecipientType; id: string } | null {
    if (hasRole(ctx, 'CUSTOMER') && ctx.customerId) return { type: 'CUSTOMER', id: ctx.customerId };
    if (ctx.userId) return { type: 'USER', id: ctx.userId };
    return null;
  }

  private assertOwner(ctx: RequestContext, ownerType: RecipientType, ownerId: string): void {
    const own = this.ownerOf(ctx);
    if (!own || own.type !== ownerType || own.id !== ownerId) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Зөвхөн өөрийн төхөөрөмжийг бүртгэнэ' });
    }
  }
}

