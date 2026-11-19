import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { runExclusive } from '@los/database';
import { PrismaService } from '../../prisma.service';
import { MakerCheckerService } from './maker-checker.service';

/** M9: cross-pod advisory lock key (rows are SKIP LOCKED anyway; the lock stops duplicate sweeps doing wasted work). */
export const MAKER_CHECKER_EXPIRY_LOCK = 'origination:maker-checker-expiry-sweeper';

const BATCH = 100;
const DEFAULT_SECONDS = 60;
const MAX_SECONDS = 3600; // setInterval-ийн 2^31-1 мс хязгаараас хол доогуур

/**
 * MAKER_CHECKER_SWEEP_SECONDS: хоосон/заагаагүй → 60; "0" → зориудаар унтраана; буруу утга (NaN, сөрөг) → анхдагч + анхааруулга;
 * 1…3600-аар хязгаарлана (хэт том утга sweeper-ийг 1 мс-д дахин дахин ажиллуулдаг байсан).
 */
export function parseSweepSeconds(raw: string | undefined): { seconds: number; warning?: string } {
  const text = raw?.trim();
  if (!text) return { seconds: DEFAULT_SECONDS };
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return { seconds: DEFAULT_SECONDS, warning: `invalid MAKER_CHECKER_SWEEP_SECONDS="${text}", using ${DEFAULT_SECONDS}` };
  if (n === 0) return { seconds: 0 };
  return { seconds: Math.min(Math.max(n, 1), MAX_SECONDS) };
}

/** MC-BR-6: хугацаа нь дууссан PENDING хүсэлтийг EXPIRED болгоно. MAKER_CHECKER_SWEEP_SECONDS=0 бол унтраана. Зэрэг олон instance аюулгүй (SKIP LOCKED). */
@Injectable()
export class ExpirySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ExpirySweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(MakerCheckerService) private readonly svc: MakerCheckerService, @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService) {}

  onModuleInit() {
    const { seconds, warning } = parseSweepSeconds(process.env.MAKER_CHECKER_SWEEP_SECONDS);
    if (warning) this.log.warn(warning);
    if (seconds === 0) {
      this.log.warn('expiry sweeper disabled (MAKER_CHECKER_SWEEP_SECONDS=0): overdue requests are only closed lazily');
      return;
    }
    this.log.log(`expiry sweeper every ${seconds}s`);
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let total = 0;
    try {
      const sweep = async () => { for (let n = BATCH; n === BATCH;) { n = await this.svc.expireOverdue(BATCH); total += n; } };
      // DB-гүй (санах ойн store, нэг процесс) горимд pod хоорондын lock шаардлагагүй (M9)
      if (this.prisma) await runExclusive(this.prisma, MAKER_CHECKER_EXPIRY_LOCK, sweep);
      else await sweep();
    } catch (e) {
      this.log.error(`sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
    }
    return total;
  }
}
