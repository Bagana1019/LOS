// FR-11.4 Үе үе ажиллаж, хугацаа дууссан хүсэлтийг хааж (provider аль хэдийн SIGNED бол finalize), гацсан FINALIZING-ийг дахин оролдоно.
// ESIGN_SWEEP_INTERVAL_SEC=0 бол унтраасан. Тик бүр давхцахгүй, алдаа процессыг унагахгүй; лог-д ЗӨВХӨН тоо.
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ESIGN_CONFIG, type EsignConfig } from './esign.config';
import { SigningService } from './signing.service';

@Injectable()
export class SigningSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SigningSweeperService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    @Inject(SigningService) private readonly signing: SigningService,
    @Inject(ESIGN_CONFIG) private readonly config: EsignConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.sweepIntervalSec <= 0) {
      this.logger.log(JSON.stringify({ event: 'esign.sweeper.disabled' }));
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.config.sweepIntervalSec * 1000);
    // Sweeper ганцаараа процессыг амьд байлгахгүй (graceful shutdown, тест)
    this.timer.unref();
  }

  /** Зогсоож, ажиллаж буй тикийг дуустал хүлээнэ */
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Нэг sweep. Өмнөх нь дуусаагүй бол алгасна. Хэзээ ч reject хийхгүй */
  tick(): Promise<void> {
    if (this.running) return this.running;
    const run = this.runOnce().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async runOnce(): Promise<void> {
    try {
      const result = await this.signing.sweep();
      if (result.scanned > 0) this.logger.log(JSON.stringify({ event: 'esign.sweep', ...result }));
    } catch (error) {
      this.logger.error(JSON.stringify({ event: 'esign.sweep.failed', errorName: error instanceof Error ? error.name : 'UnknownError' }));
    }
  }
}
