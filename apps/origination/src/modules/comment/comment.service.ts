import { Injectable } from '@nestjs/common';
import type { CommentListResponse, CommentView, CreateCommentRequest, RequestContext } from '@los/contracts';
import { Clock } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { ApplicationAccessService } from '../../shared/application-access.service';
import { NotificationService } from '../notification/notification.service';

const PREVIEW = 120;

/** FR-13.4: хүсэлт бүрт тайлбар/чат. Унших — хүсэлтийн хүрээ (read), бичих — унших эрхтэй бүх ажилтан (батлагч, салбарын захирал тайлбар үлдээнэ). */
@Injectable()
export class CommentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ApplicationAccessService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  async list(ctx: RequestContext, applicationId: string): Promise<CommentListResponse> {
    await this.access.load(ctx, applicationId, 'read');
    const rows = await this.prisma.comment.findMany({ where: { orgId: ctx.orgId, applicationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return { items: rows.map(toView) };
  }

  async create(ctx: RequestContext, applicationId: string, input: CreateCommentRequest): Promise<CommentView> {
    const app = await this.access.load(ctx, applicationId, 'read');
    const mentions = [...new Set(input.mentions)].filter((u) => u !== ctx.userId);
    const row = await this.prisma.$transaction(async (tx) => {
      const c = await tx.comment.create({ data: { orgId: ctx.orgId, applicationId, authorId: ctx.userId ?? 'unknown', body: input.body, mentions, createdAt: this.clock.now(), createdBy: ctx.userId ?? null } });
      await tx.auditLog.create({ data: { orgId: ctx.orgId, entity: 'COMMENT', entityId: c.id, action: 'COMMENT_ADDED', actorId: ctx.userId ?? null, applicationId, correlationId: ctx.correlationId ?? null, afterJson: { mentions, length: input.body.length } } });
      // Таныг дурдсан ажилтны хонх (FR-13.2 MENTION)
      await this.notifications.notifyUsers({ orgId: ctx.orgId, userIds: mentions, type: 'MENTION', applicationId, payload: { applicationNo: app.appNo, comment: input.body.slice(0, PREVIEW) } }, tx);
      return c;
    });
    return toView(row);
  }
}

function toView(c: { id: string; applicationId: string; authorId: string; body: string; mentions: string[]; createdAt: Date }): CommentView {
  return { id: c.id, applicationId: c.applicationId, authorId: c.authorId, body: c.body, mentions: c.mentions, createdAt: c.createdAt.toISOString() };
}
