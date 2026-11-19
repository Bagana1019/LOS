import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { runExclusive } from '@los/database';
import { PrismaService } from '../../prisma.service';
import { ApprovalService } from './approval.service';

/** M9: cross-pod advisory lock key — only one pod runs a tick. */
export const APPROVAL_SLA_LOCK = 'origination:approval-sla-sweeper';

/** FR-10.2: SLA хэтэрсэн түвшний мэдэгдэл. APPROVAL_SLA_SWEEP_SECONDS (анхдагч 300; "0" → унтраана). Олон pod: tick бүр advisory lock (M9). */
@Injectable()
export class ApprovalSlaSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ApprovalSlaSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly approvals: ApprovalService, private readonly prisma: PrismaService) {}

  onModuleInit() {
    const raw = Number(process.env.APPROVAL_SLA_SWEEP_SECONDS ?? 300);
    const seconds = Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 3600) : 300;
    if (seconds === 0 || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const r = await runExclusive(this.prisma, APPROVAL_SLA_LOCK, () => this.approvals.sweepSla());
      return r.ran ? r.value : 0;
    } catch (e) { this.log.error(`sla sweep failed: ${e instanceof Error ? e.message : String(e)}`); return 0; } finally { this.running = false; }
  }
}
