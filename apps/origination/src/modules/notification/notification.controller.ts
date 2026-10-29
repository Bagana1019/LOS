import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Res } from '@nestjs/common';
import { z } from 'zod';
import {
  DeliveryListQuery, NotificationListQuery, NotificationPreferenceRequest, PreviewTemplateRequest, RecipientType, RegisterPushDeviceRequest, RunRemindersRequest, SendTestRequest, UpsertTemplateRequest,
  type DeliveryListResponse, type DeliveryView, type MarkAllReadResponse, type NotificationListResponse, type NotificationPreferenceView, type NotificationView, type PreviewTemplateResponse,
  type PushDeviceView, type RunRemindersResponse, type TemplateView, type UnreadCountResponse,
} from '@los/contracts';
import { Ctx } from '@los/nest-common';
import type { RequestContext } from '@los/contracts';
import { Roles } from '@los/nest-common';
import { ZodValidationPipe } from '@los/nest-common';
import { DeliveryAdminService } from './delivery-admin.service';
import { NotificationService } from './notification.service';
import { PreferenceService } from './preference.service';
import { PushDeviceService } from './push-device.service';
import { ReminderService } from './reminder.service';
import { TemplateService } from './template.service';

/** express нь шууд dependency биш тул зөвхөн хэрэгтэй хэсгийг бүтцээр тодорхойлно. */
interface StatusSetter { status(code: number): unknown }

const RunBody = z.preprocess((v) => v ?? {}, RunRemindersRequest);
const RecipientTypeParam = new ZodValidationPipe(z.enum(RecipientType));
const TokenParam = new ZodValidationPipe(z.string().min(8).max(4096));

@Controller()
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly templates: TemplateService,
    private readonly deliveries: DeliveryAdminService,
    private readonly reminders: ReminderService,
    private readonly devices: PushDeviceService,
    private readonly preferences: PreferenceService,
  ) {}

  // ── Хонх (in-app): нэвтэрсэн ажилтан, зөвхөн өөрийн ──────────────────────────────
  @Get('notifications')
  list(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(NotificationListQuery)) query: NotificationListQuery): Promise<NotificationListResponse> { return this.notifications.list(ctx, query); }

  @Get('notifications/unread-count')
  unreadCount(@Ctx() ctx: RequestContext): Promise<UnreadCountResponse> { return this.notifications.unreadCount(ctx); }

  @Post('notifications/read-all')
  @HttpCode(200)
  readAll(@Ctx() ctx: RequestContext): Promise<MarkAllReadResponse> { return this.notifications.markAllRead(ctx); }

  @Post('notifications/:id/read')
  @HttpCode(200)
  read(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<NotificationView> { return this.notifications.markRead(ctx, id); }

  // ── Загвар (ADMIN) ──────────────────────────────────────────────────────────────
  @Get('notifications/templates')
  @Roles('ADMIN')
  listTemplates(@Ctx() ctx: RequestContext): Promise<TemplateView[]> { return this.templates.list(ctx.orgId); }

  @Put('notifications/templates')
  @Roles('ADMIN')
  upsertTemplate(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(UpsertTemplateRequest)) dto: UpsertTemplateRequest): Promise<TemplateView> { return this.templates.upsert(ctx.orgId, ctx.userId, dto); }

  @Post('notifications/templates/preview')
  @Roles('ADMIN')
  @HttpCode(200)
  previewTemplate(@Body(new ZodValidationPipe(PreviewTemplateRequest)) dto: PreviewTemplateRequest): PreviewTemplateResponse { return this.templates.preview(dto); }

  // ── Хүргэлтийн бүртгэл, туршилт, сануулга ───────────────────────────────────────
  @Get('notifications/deliveries')
  @Roles('ADMIN', 'BRANCH_MANAGER')
  listDeliveries(@Ctx() ctx: RequestContext, @Query(new ZodValidationPipe(DeliveryListQuery)) query: DeliveryListQuery): Promise<DeliveryListResponse> { return this.deliveries.list(ctx, query); }

  @Post('notifications/test-send')
  @Roles('ADMIN')
  @HttpCode(200)
  testSend(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(SendTestRequest)) dto: SendTestRequest): Promise<DeliveryView> { return this.deliveries.testSend(ctx, dto); }

  @Post('notifications/reminders/run')
  @Roles('ADMIN')
  @HttpCode(200)
  runReminders(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(RunBody)) dto: RunRemindersRequest): Promise<RunRemindersResponse> { return this.reminders.run(ctx.orgId, { asOf: dto.asOf, dryRun: dto.dryRun }); }

  // ── Push төхөөрөмж ──────────────────────────────────────────────────────────────
  /** 201 — шинэ төхөөрөмж; 200 — токен байсан тул шинэчилсэн. */
  @Post('notifications/push-devices')
  async registerDevice(@Ctx() ctx: RequestContext, @Body(new ZodValidationPipe(RegisterPushDeviceRequest)) dto: RegisterPushDeviceRequest, @Res({ passthrough: true }) res: StatusSetter): Promise<PushDeviceView> {
    const { view, created } = await this.devices.register(ctx, dto);
    if (!created) res.status(200);
    return view;
  }

  @Delete('notifications/push-devices/:token')
  @HttpCode(204)
  async removeDevice(@Ctx() ctx: RequestContext, @Param('token', TokenParam) token: string): Promise<void> { await this.devices.remove(ctx, token); }

  // ── Сувгийн opt-out ─────────────────────────────────────────────────────────────
  @Get('notifications/preferences/:recipientType/:recipientId')
  getPreferences(@Ctx() ctx: RequestContext, @Param('recipientType', RecipientTypeParam) recipientType: RecipientType, @Param('recipientId') recipientId: string): Promise<NotificationPreferenceView> {
    return this.preferences.get(ctx, recipientType, recipientId);
  }

  @Put('notifications/preferences/:recipientType/:recipientId')
  putPreferences(
    @Ctx() ctx: RequestContext, @Param('recipientType', RecipientTypeParam) recipientType: RecipientType, @Param('recipientId') recipientId: string,
    @Body(new ZodValidationPipe(NotificationPreferenceRequest)) dto: NotificationPreferenceRequest,
  ): Promise<NotificationPreferenceView> {
    return this.preferences.put(ctx, recipientType, recipientId, dto);
  }
}
