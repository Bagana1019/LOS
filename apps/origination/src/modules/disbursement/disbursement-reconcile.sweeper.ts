import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DisbursementService } from './disbursement.service';

const DEFAULT_SECONDS = 300;
const MAX_SECONDS = 3600;

/** DISBURSEMENT_RECONCILE_SWEEP_SECONDS: хоосон/буруу → 300; "0" → унтраана; 1…3600-аар хязгаарлана. */
export function parseReconcileSeconds(raw: string | undefined): number {
  const n = Number(raw?.trim() || DEFAULT_SECONDS);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SECONDS;
  return n === 0 ? 0 : Math.min(Math.max(n, 1), MAX_SECONDS);
}

/**
 * H1 (FR-12.5): Core-д данс нээгдээд LOS-д бүртгэгдээгүй (APPROVED, lease хугацаа хэтэрсэн) олголтыг дуусгана.
 * Олон pod-д аюулгүй: `reconcileStale` мөр бүрийг CAS lease-ээр авдаг тул нэг мөрийг нэг л pod боловсруулна. Sweeper хэзээ ч `openLoan` дуудахгүй.
 * Тодорхойгүй үр дүнтэй мөрт "олдсонгүй"-г settle дүрмээр (`isNotFoundDefinitive`) л FAILED болгоно; өмнө нь лавлагааг тоолж APPROVED үлдээнэ.
 */
@Injectable()
export class DisbursementReconcileSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DisbursementReconcileSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly disbursement: DisbursementService) {}

  onModuleInit() {
    const seconds = parseReconcileSeconds(process.env.DISBURSEMENT_RECONCILE_SWEEP_SECONDS);
    if (seconds === 0 || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), seconds * 1000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try { return await this.disbursement.reconcileStale(); } catch (e) { this.log.error(`disbursement reconcile sweep failed: ${e instanceof Error ? e.name : typeof e}`); return 0; } finally { this.running = false; }
  }
}
