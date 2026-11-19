import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { runExclusive } from '@los/database';
import { PrismaService } from '../../prisma.service';
import { RetentionService, type SweepResult } from './retention.service';

/** M9/M10: pod хоорондын advisory lock — нэг л pod нэг удаад устгана. */
export const DMS_RETENTION_LOCK = 'dms:retention-sweeper';

const DEFAULT_SECONDS = 3600;
const MAX_SECONDS = 86_400;
const DEFAULT_BATCH = 100;
const MAX_BATCH = 1000;
const EMPTY: SweepResult = { stamped: 0, purged: 0, failed: 0, skipped: 0 };

type Env = Readonly<Record<string, string | undefined>>;

/**
 * DMS_RETENTION_SWEEP_SECONDS: хоосон → 3600; "0" → унтраана; буруу → анхдагч + анхааруулга; 1…86400.
 * DMS_RETENTION_BATCH_SIZE: tick тутмын дээд файл (анхдагч 100); буруу/0 → анхдагч + анхааруулга; 1…1000.
 */
export function parseRetentionConfig(env: Env): { seconds: number; batch: number; warnings: string[] } {
  const warnings: string[] = [];
  const read = (name: string, fallback: number, min: number, max: number, allowZero: boolean): number => {
    const text = env[name]?.trim();
    if (!text) return fallback;
    const n = Number(text);
    if (allowZero && n === 0) return 0;
    if (!Number.isInteger(n) || n < 1) {
      warnings.push(`invalid ${name}="${text.slice(0, 32)}", using ${fallback}`);
      return fallback;
    }
    return Math.min(Math.max(n, min), max);
  };
  return {
    seconds: read('DMS_RETENTION_SWEEP_SECONDS', DEFAULT_SECONDS, 1, MAX_SECONDS, true),
    batch: read('DMS_RETENTION_BATCH_SIZE', DEFAULT_BATCH, 1, MAX_BATCH, false),
    warnings,
  };
}

/** Хадгалах хугацааны sweeper (BSA-BR-8-тэй ижил зарчим, docs/03 `retention_policy`). Лог-д зөвхөн тоо — файлын нэр, түлхүүр, PII бичихгүй. */
@Injectable()
export class RetentionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RetentionSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly config = parseRetentionConfig(process.env);

  constructor(@Inject(RetentionService) private readonly retention: RetentionService, @Optional() @Inject(PrismaService) private readonly prisma?: PrismaService) {}

  onModuleInit() {
    for (const w of this.config.warnings) this.log.warn(w);
    if (this.config.seconds === 0) {
      this.log.warn('retention sweeper disabled (DMS_RETENTION_SWEEP_SECONDS=0): expired files are not purged');
      return;
    }
    this.log.log(`retention sweeper every ${this.config.seconds}s, batch ${this.config.batch}`);
    this.timer = setInterval(() => void this.tick(), this.config.seconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(now: Date = new Date()): Promise<SweepResult> {
    if (this.running) return EMPTY;
    this.running = true;
    try {
      const sweep = () => this.retention.sweep(now, this.config.batch);
      const outcome = this.prisma ? await runExclusive(this.prisma, DMS_RETENTION_LOCK, sweep) : { ran: true as const, value: await sweep() };
      if (!outcome.ran) return EMPTY; // өөр pod ажиллаж байна
      const r = outcome.value;
      if (r.stamped || r.purged || r.failed || r.skipped) this.log.log(`retention sweep: stamped=${r.stamped} purged=${r.purged} failed=${r.failed} skipped=${r.skipped}`);
      return r;
    } catch (e) {
      this.log.error(`retention sweep failed: ${e instanceof Error ? e.name : 'Error'}`); // мессежид SQL утга/түлхүүр орж болзошгүй тул нэр л
      return EMPTY;
    } finally {
      this.running = false;
    }
  }
}
