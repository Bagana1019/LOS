import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Clock } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { OrgSettings } from '../../shared/org-settings';

export interface ArchiveResult { archived: number; days: number }

/**
 * FR-1.6: `draft.auto_archive_days` хоног өөрчлөгдөөгүй ноорог (DRAFT) хүсэлтийг `archived_at`-ээр тэмдэглэнэ (төлөв өөрчлөхгүй, устгахгүй).
 * Жагсаалтаас (default) нуугдана; хүсэлт дахин засагдвал `updated_at` шинэчлэгдэх ч архив хэвээр (DECISIONS: Q-125 DEMO).
 */
@Injectable()
export class DraftArchiveService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DraftArchiveService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly prisma: PrismaService, private readonly settings: OrgSettings, private readonly clock: Clock) {}

  /** DRAFT_ARCHIVE_SWEEP_SECONDS (анхдагч 3600; "0" → унтраана). */
  onModuleInit() {
    const raw = Number(process.env.DRAFT_ARCHIVE_SWEEP_SECONDS ?? 3600);
    const seconds = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 86_400) : 0;
    if (!seconds) return;
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const orgs = await this.prisma.loanApplication.findMany({ where: { status: 'DRAFT', archivedAt: null }, distinct: ['orgId'], select: { orgId: true } });
      for (const { orgId } of orgs) await this.archiveStale(orgId);
    } catch (e) { this.log.error(`draft archive failed: ${e instanceof Error ? e.message : String(e)}`); } finally { this.running = false; }
  }

  async archiveStale(orgId: string, actorId: string | null = null): Promise<ArchiveResult> {
    const days = await this.settings.get(orgId, 'draft.auto_archive_days');
    const cutoff = new Date(this.clock.now().getTime() - days * 86_400_000);
    return this.prisma.$transaction(async (tx) => {
      const stale = await tx.loanApplication.findMany({ where: { orgId, status: 'DRAFT', archivedAt: null, updatedAt: { lt: cutoff } }, select: { id: true } });
      if (!stale.length) return { archived: 0, days };
      const now = this.clock.now();
      await tx.loanApplication.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { archivedAt: now } });
      await tx.auditLog.createMany({ data: stale.map((s) => ({ orgId, entity: 'LOAN_APPLICATION', entityId: s.id, action: 'DRAFT_ARCHIVED', actorId, applicationId: s.id, at: now, afterJson: { archivedAt: now.toISOString(), days } })) });
      return { archived: stale.length, days };
    });
  }
}
