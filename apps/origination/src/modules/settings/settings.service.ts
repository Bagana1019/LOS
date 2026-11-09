import { Injectable, NotFoundException } from '@nestjs/common';
import {
  SETTING_ACTION_UPDATE, SETTING_KEYS, SETTING_REGISTRY, SETTING_TARGET_TYPE, isFourEyesSettingKey, isSettingKey, parseSetting,
  type RequestContext, type SettingKey, type SubmitChangeResult,
} from '@los/contracts';
import { DomainError } from '@los/nest-common';
import { buildEvent, enqueueOutbox, recordAudit } from '@los/database';
import type { Prisma } from '.prisma/client-origination';
import { PrismaService } from '../../prisma.service';
import { actorFrom } from '../maker-checker/actor';
import { MakerCheckerService } from '../maker-checker/maker-checker.service';

export interface SettingView { key: string; value: unknown; description: string; isDefault: boolean; updatedAt: string | null }

/** Утгыг бүртгэлийн схемээр шалгана (ZodError → AllExceptionsFilter 400) + түлхүүр тус бүрийн нэмэлт шалгалт. */
export function checkSetting(key: SettingKey, value: unknown): unknown {
  const parsed = parseSetting(key, value);
  if (key === 'contract.branch_codes') { // BR-11: салбарын код давхцвал хоёр салбарын гэрээний дугаар андуурагдана
    const codes = Object.values(parsed as Record<string, string>).map((c) => c.toUpperCase());
    if (new Set(codes).size !== codes.length) throw new DomainError('BRANCH_CODE_DUPLICATE', 'Салбарын код давхардсан байна', 422);
  }
  return parsed;
}

/** Хадгалалт: upsert + audit + SettingsChanged outbox. Дуудагч tx-ээ өгнө (шууд бичих эсвэл checker батлах үед). */
export async function applySetting(
  tx: Prisma.TransactionClient, who: { orgId: string; actorId: string; correlationId: string }, key: SettingKey, parsed: unknown, extraAudit: Record<string, unknown> = {},
) {
  const before = await tx.setting.findUnique({ where: { orgId_key: { orgId: who.orgId, key } } });
  const saved = await tx.setting.upsert({
    where: { orgId_key: { orgId: who.orgId, key } },
    create: { orgId: who.orgId, key, valueJson: parsed as never, createdBy: who.actorId, updatedBy: who.actorId },
    update: { valueJson: parsed as never, updatedBy: who.actorId },
  });
  await recordAudit(tx, { orgId: who.orgId, entity: 'SETTING', entityId: key, action: 'SETTING_UPDATED', actorId: who.actorId, beforeJson: before ? { value: before.valueJson } : null, afterJson: { value: parsed, ...extraAudit }, correlationId: who.correlationId });
  await enqueueOutbox(tx, buildEvent({ orgId: who.orgId, userId: who.actorId, correlationId: who.correlationId }, 'SettingsChanged', { key, productId: null }));
  return saved;
}

/** Нийтлэг тохиргооны эзэмшигч (CLAUDE.md §3.2.8): бусад сервис `GET /api/settings/:key`-ээр (cache 60с) эсвэл SettingsChanged event-ээр авна. */
@Injectable()
export class SettingsService {
  constructor(private readonly db: PrismaService, private readonly mc: MakerCheckerService) {}

  async list(ctx: RequestContext): Promise<SettingView[]> {
    const rows = new Map((await this.db.setting.findMany({ where: { orgId: ctx.orgId } })).map((r) => [r.key, r]));
    return SETTING_KEYS.map((key) => this.view(key, rows.get(key)));
  }

  async get(ctx: RequestContext, key: string): Promise<SettingView> {
    if (!isSettingKey(key)) throw new NotFoundException({ code: 'SETTING_NOT_FOUND', message: `Тохиргоо олдсонгүй: ${key}` });
    return this.view(key, await this.db.setting.findUnique({ where: { orgId_key: { orgId: ctx.orgId, key } } }));
  }

  /**
   * Утгыг бүртгэлийн схемээр шалгаад хадгална (upsert + audit + SettingsChanged outbox нэг транзакцид).
   * Q-124: `FOUR_EYES_SETTING_KEYS`-ийн түлхүүр шууд бичигдэхгүй — `propose()` (Maker-Checker)-оор л орно.
   */
  async set(ctx: RequestContext, key: string, value: unknown): Promise<SettingView> {
    if (!isSettingKey(key)) throw new NotFoundException({ code: 'SETTING_NOT_FOUND', message: `Тохиргоо олдсонгүй: ${key}` });
    if (isFourEyesSettingKey(key)) throw new DomainError('FOUR_EYES_REQUIRED', 'Энэ тохиргоог 4 нүдээр (санал → баталгаажуулалт) өөрчилнө', 422);
    const parsed = checkSetting(key, value);
    const row = await this.db.$transaction((tx) => applySetting(tx, { orgId: ctx.orgId, actorId: actorFrom(ctx).userId, correlationId: ctx.correlationId }, key, parsed));
    return this.view(key, row);
  }

  /** Q-124: 4 нүдтэй түлхүүрийн өөрчлөлтийг санал болгоно (202 PENDING / 201 DIRECT — policy идэвхгүй бол). */
  async propose(ctx: RequestContext, key: string, value: unknown, reason: string | undefined): Promise<SubmitChangeResult> {
    if (!isSettingKey(key)) throw new NotFoundException({ code: 'SETTING_NOT_FOUND', message: `Тохиргоо олдсонгүй: ${key}` });
    if (!isFourEyesSettingKey(key)) throw new DomainError('FOUR_EYES_NOT_APPLICABLE', 'Энэ тохиргоо 4 нүдтэй биш', 422);
    const parsed = checkSetting(key, value); // maker-т эртхэн алдаа харуулна; handler apply-д дахин шалгана
    return this.mc.submit(actorFrom(ctx), { targetType: SETTING_TARGET_TYPE, action: SETTING_ACTION_UPDATE, targetId: key, payload: { key, value: parsed }, reason: reason ?? '' });
  }

  private view(key: (typeof SETTING_KEYS)[number], row?: { valueJson: unknown; updatedAt: Date } | null): SettingView {
    const def = SETTING_REGISTRY[key];
    return { key, value: row ? row.valueJson : def.default, description: def.description, isDefault: !row, updatedAt: row?.updatedAt.toISOString() ?? null };
  }
}
