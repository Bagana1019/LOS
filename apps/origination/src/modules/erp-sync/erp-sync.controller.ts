// ERP синкийн ops API (зөвхөн `erp-sync:manage` = ADMIN): жагсаалт, төлөв, DEAD үйл явдлыг дахин оролдуулах/хаах. (FIN-SYNC-6)
// Бүх унших/бичих нь хүсэлтийн байгууллагаар (ctx.orgId) хязгаарлагдана — өөр байгууллагын үйл явдал 404.
import { Body, Controller, Get, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ErpEventCancelBody, ErpEventListQuery, ErpEventRequeueBody, ErpEventRequeueDeadBody, type RequestContext } from '@los/contracts';
import { Clock, Ctx, DomainError, Permissions, SystemClock, conflict, notFound } from '@los/nest-common';
import { ErpEventNotFoundError, ErpEventStateError } from './erp-sync.errors';
import { ERP_EVENT_REPOSITORY, type ErpEventDetail, type ErpEventRecord, type ErpEventRepository } from './erp-event.repository';
import { OutboxRelayService } from './outbox-relay.service';

const view = ({ contentHash: _contentHash, ...e }: ErpEventRecord) => ({
  ...e, seq: e.seq.toString(), nextAttemptAt: e.nextAttemptAt.toISOString(), lockedUntil: e.lockedUntil?.toISOString() ?? null,
  sentAt: e.sentAt?.toISOString() ?? null, createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString(),
});

function mapError(e: unknown, id?: string): never {
  if (e instanceof ErpEventNotFoundError) throw notFound('ERP үйл явдал', id);
  if (e instanceof ErpEventStateError) throw conflict('ERP_EVENT_STATE_CONFLICT', `ERP үйл явдлын одоогийн төлвөөс энэ үйлдлийг хийх боломжгүй: ${e.message}`);
  throw e;
}
// Гар үйлдэл аудитад хэн хийснийг заавал тэмдэглэнэ
function actorOf(ctx: RequestContext): string {
  if (!ctx.userId) throw new DomainError('UNAUTHENTICATED', 'Хэрэглэгчийн ID олдсонгүй', 401);
  return ctx.userId;
}

@Controller('erp-sync/events')
@Permissions('erp-sync:manage')
export class ErpSyncController {
  private readonly clock: Clock;

  constructor(
    @Inject(ERP_EVENT_REPOSITORY) private readonly repo: ErpEventRepository,
    @Inject(OutboxRelayService) private readonly relay: OutboxRelayService,
    @Optional() @Inject(Clock) clock?: Clock,
  ) { this.clock = clock ?? new SystemClock(); }

  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const { items, nextCursor } = await this.repo.list({ ...ErpEventListQuery.parse(query ?? {}), orgId: ctx.orgId });
    return { items: items.map(view), nextCursor };
  }

  @Get('stats')
  async stats(@Ctx() ctx: RequestContext) {
    const s = await this.repo.stats(ctx.orgId);
    const now = this.clock.now().getTime();
    return {
      counts: s.counts, oldestPendingAt: s.oldestPendingAt?.toISOString() ?? null, nextAttemptAt: s.nextAttemptAt?.toISOString() ?? null,
      lagSeconds: s.oldestPendingAt ? Math.max(0, Math.round((now - s.oldestPendingAt.getTime()) / 1000)) : 0,
      relay: this.relay.status(),
    };
  }

  // Relay-г даруй нэг удаа ажиллуулна (dev, ops). Relay нь бүх байгууллагын PENDING үйл явдлыг боловсруулдаг.
  @Post('dispatch')
  dispatch(@Ctx() ctx: RequestContext) { actorOf(ctx); return this.relay.tick(); }

  // DEAD үйл явдлуудыг бөөнөөр дахин оролдуулна (буруу URL/эрх зассаны дараа). errorCode-оор шүүнэ.
  @Post('requeue-dead')
  async requeueDead(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const by = actorOf(ctx);
    const b = ErpEventRequeueDeadBody.parse(body ?? {});
    const ids: string[] = [];
    let cursor: string | undefined;
    while (ids.length < b.limit) {
      const page = await this.repo.list({ orgId: ctx.orgId, status: 'DEAD', errorCode: b.errorCode, limit: Math.min(100, b.limit - ids.length), cursor });
      ids.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const failed: Array<{ id: string; error: string }> = [];
    let requeued = 0;
    for (const id of ids) {
      try { await this.repo.requeue(id, by, b.note ?? null, this.clock.now()); requeued++; }
      catch (e) { failed.push({ id, error: e instanceof Error ? e.message : String(e) }); }
    }
    return { matched: ids.length, requeued, failed };
  }

  @Get(':id')
  async get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    const { deliveries, ...event } = await this.own(ctx, id);
    return {
      ...view(event),
      deliveries: deliveries.map((d) => ({ ...d, startedAt: d.startedAt.toISOString(), finishedAt: d.finishedAt?.toISOString() ?? null })),
    };
  }

  @Post(':id/requeue')
  async requeue(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const by = actorOf(ctx);
    const b = ErpEventRequeueBody.parse(body ?? {});
    await this.own(ctx, id);
    try { return view(await this.repo.requeue(id, by, b.note ?? null, this.clock.now())); } catch (e) { return mapError(e, id); }
  }

  @Post(':id/cancel')
  async cancel(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const by = actorOf(ctx);
    const { note } = ErpEventCancelBody.parse(body ?? {});
    await this.own(ctx, id);
    try { return view(await this.repo.cancel(id, by, note, this.clock.now())); } catch (e) { return mapError(e, id); }
  }

  // Өөр байгууллагын үйл явдлын оршихуйг задруулахгүйн тулд «олдсонгүй» гэж хариулна
  private async own(ctx: RequestContext, id: string): Promise<ErpEventDetail> {
    const e = await this.repo.getById(id);
    if (!e || e.orgId !== ctx.orgId) throw notFound('ERP үйл явдал', id);
    return e;
  }
}
