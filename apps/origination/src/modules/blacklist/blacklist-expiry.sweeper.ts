import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { BlacklistService } from './blacklist.service';

const DEFAULT_SECONDS = 3600;
const MAX_SECONDS = 86_400;

/** BLACKLIST_EXPIRY_SWEEP_SECONDS: хоосон → 3600; "0" → унтраана; буруу утга → анхдагч; 1…86400-аар хязгаарлана. */
export function parseExpirySeconds(raw: string | undefined): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_SECONDS;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SECONDS;
  return n === 0 ? 0 : Math.min(Math.max(n, 1), MAX_SECONDS);
}

/** Q-131: хугацаа нь дууссан (Саарал) бүртгэлийг автоматаар идэвхгүй болгоно. Хайлт validUntil-ийг өөрөө шалгадаг тул хоцролт анхааруулгад нөлөөлөхгүй. */
@Injectable()
export class BlacklistExpirySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BlacklistExpirySweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(BlacklistService) private readonly svc: BlacklistService) {}

  onModuleInit() {
    const seconds = parseExpirySeconds(process.env.BLACKLIST_EXPIRY_SWEEP_SECONDS);
    if (seconds === 0) { this.log.warn('blacklist expiry sweeper disabled (BLACKLIST_EXPIRY_SWEEP_SECONDS=0)'); return; }
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let total = 0;
      for (let n = 100; n === 100;) { n = await this.svc.expireDue(100); total += n; }
      return total;
    } catch (e) {
      this.log.error(`blacklist expiry sweep failed: ${e instanceof Error ? e.name : typeof e}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
