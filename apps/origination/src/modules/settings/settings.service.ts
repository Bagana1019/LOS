import { Injectable, NotFoundException } from '@nestjs/common';
import { SETTING_KEYS, SETTING_REGISTRY, type RequestContext, isSettingKey, parseSetting } from '@los/contracts';
import { buildEvent, enqueueOutbox, recordAudit } from '@los/database';
import { PrismaService } from '../../prisma.service';

export interface SettingView { key: string; value: unknown; description: string; isDefault: boolean; updatedAt: string | null }

/** Нийтлэг тохиргооны эзэмшигч (CLAUDE.md §3.2.8): бусад сервис `GET /api/settings/:key`-ээр (cache 60с) эсвэл SettingsChanged event-ээр авна. */
@Injectable()
export class SettingsService {
  constructor(private readonly db: PrismaService) {}

  async list(ctx: RequestContext): Promise<SettingView[]> {
    const rows = new Map((await this.db.setting.findMany({ where: { orgId: ctx.orgId } })).map((r) => [r.key, r]));
    return SETTING_KEYS.map((key) => this.view(key, rows.get(key)));
  }

  async get(ctx: RequestContext, key: string): Promise<SettingView> {
    if (!isSettingKey(key)) throw new NotFoundException({ code: 'SETTING_NOT_FOUND', message: `Тохиргоо олдсонгүй: ${key}` });
    return this.view(key, await this.db.setting.findUnique({ where: { orgId_key: { orgId: ctx.orgId, key } } }));
  }

  /** Утгыг бүртгэлийн схемээр шалгана → upsert + audit + SettingsChanged outbox нэг транзакцид. */
  async set(ctx: RequestContext, key: string, value: unknown): Promise<SettingView> {
    if (!isSettingKey(key)) throw new NotFoundException({ code: 'SETTING_NOT_FOUND', message: `Тохиргоо олдсонгүй: ${key}` });
    const parsed = parseSetting(key, value); // ZodError → AllExceptionsFilter 400
    const row = await this.db.$transaction(async (tx) => {
      const before = await tx.setting.findUnique({ where: { orgId_key: { orgId: ctx.orgId, key } } });
      const saved = await tx.setting.upsert({
        where: { orgId_key: { orgId: ctx.orgId, key } },
        create: { orgId: ctx.orgId, key, valueJson: parsed as never, createdBy: ctx.userId, updatedBy: ctx.userId },
        update: { valueJson: parsed as never, updatedBy: ctx.userId },
      });
      await recordAudit(tx, { orgId: ctx.orgId, entity: 'SETTING', entityId: key, action: 'SETTING_UPDATED', actorId: ctx.userId, beforeJson: before ? { value: before.valueJson } : null, afterJson: { value: parsed }, correlationId: ctx.correlationId });
      await enqueueOutbox(tx, buildEvent(ctx, 'SettingsChanged', { key, productId: null }));
      return saved;
    });
    return this.view(key, row);
  }

  private view(key: (typeof SETTING_KEYS)[number], row?: { valueJson: unknown; updatedAt: Date } | null): SettingView {
    const def = SETTING_REGISTRY[key];
    return { key, value: row ? row.valueJson : def.default, description: def.description, isDefault: !row, updatedAt: row?.updatedAt.toISOString() ?? null };
  }
}
