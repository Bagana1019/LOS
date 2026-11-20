import { type DynamicModule, type InjectionToken, Logger, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AUDIT_SEAL_COLUMNS, auditKeyringFromEnv, describeDbError, sealAuditLog, type AuditColumn, type AuditKeyring, type AuditSealDb, type SealHead } from '@los/database';
import { auditSealSchedule } from '../auth/audit-hmac-key';

/**
 * Audit seal (docs/DECISIONS.md 2026-11-19 · audit seal): `AUDIT_SEAL_INTERVAL_MS` (анхдагч 60с) тутам commit болсон мөрийг `<schema>.audit_seal`-д
 * гинжилнэ. Олон pod аюулгүй (advisory xact lock, `seq` PK). Лог: seq, мөрийн тоо, mac л (түлхүүр, мөрийн агуулга биш) — `AUDIT_SEALED … mac=…`
 * мөрийг WORM storage руу илгээх нь deploy-ийн шаардлага (verify-ийн anchor). Pod бүр сүүлд харсан толгойгоо санаж, DB-ийн гинж түүнээс ухарсан /
 * өөрчлөгдсөн, horizon ухарсан, хуучин түлхүүр рүү буцсан бол `AUDIT_SEAL_<REASON>` алдаа логлоод seal хийхээ ЗОГСООНО (апп унахгүй).
 */
export class AuditSealerHost implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger('AuditSeal');
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private keyring: AuditKeyring | null = null;
  private head: SealHead | null = null;
  private halted = false;

  constructor(
    private readonly db: AuditSealDb, private readonly schema: string, private readonly columns: readonly AuditColumn[],
    private readonly env: Record<string, string | undefined> = process.env,
    /** Тест/оношлогоонд: batch-ийн хэмжээ (анхдагч sealAuditLog-ийнх, 500). */
    private readonly sealOpts: { batchSize?: number } = {},
  ) {}

  onModuleInit(): void {
    const s = auditSealSchedule(this.env);
    if (s.invalid) { this.log.warn(`${s.invalid}: ${this.schema}.audit_log sealing disabled on this pod (production refuses to start)`); return; }
    if (s.disabledBy) { this.log.warn(`${s.disabledBy}: ${this.schema}.audit_log sealing disabled on this pod`); return; }
    this.keyring = auditKeyringFromEnv(this.env);
    if (!this.keyring) { this.log.warn(`AUDIT_HMAC_KEY not set: ${this.schema}.audit_log sealing disabled (production refuses to start without it)`); return; }
    this.timer = setInterval(() => void this.tick(), s.intervalMs).unref();
  }

  /** Сүүлд хүлээн зөвшөөрсөн толгой (тест/оношлогоо). */
  lastHead(): SealHead | null { return this.head; }
  isHalted(): boolean { return this.halted; }

  /** Нэг tick (давхцахгүй). Тест ба CLI-д шууд дуудна. */
  tick(): Promise<void> {
    if (!this.keyring || this.halted || this.running) return this.running ?? Promise.resolve();
    // Seal бүрийг commit болмогц логлож толгойг урагшлуулна (дараагийн batch унасан ч логлогдоогүй seal үлдэхгүй).
    const onSealed = (s: { seq: string; rows: number; mac: string }, head: SealHead) => {
      this.log.log(`AUDIT_SEALED schema=${this.schema} seq=${s.seq} rows=${s.rows} mac=${s.mac}`);
      this.head = head;
    };
    this.running = sealAuditLog(this.db, { schema: this.schema, columns: this.columns }, this.keyring, { ...this.sealOpts, expectedHead: this.head, onSealed })
      .then((r) => {
        if (r.regressed) return this.halt(r.regressed);
        if (!r.locked) this.head = r.head;
      })
      .catch((e: unknown) => this.log.error(`AUDIT_SEAL_FAILED schema=${this.schema}: ${describeDbError(e)}`))
      .finally(() => { this.running = null; });
    return this.running;
  }

  private halt(reason: string): void {
    this.halted = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.log.error(`AUDIT_SEAL_${reason} schema=${this.schema} expectedSeq=${this.head?.seq ?? '-'}: sealing stopped on this pod; run audit:verify --anchor and investigate before restarting`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}

@Module({})
export class AuditSealModule {
  /** `AuditSealModule.forRoot({ schema: 'kyc', db: PrismaService })`; gateway: `columns: GATEWAY_AUDIT_SEAL_COLUMNS`. */
  static forRoot(o: { schema: string; db: InjectionToken; columns?: readonly AuditColumn[] }): DynamicModule {
    return {
      module: AuditSealModule,
      providers: [{ provide: AuditSealerHost, inject: [o.db], useFactory: (db: AuditSealDb) => new AuditSealerHost(db, o.schema, o.columns ?? AUDIT_SEAL_COLUMNS) }],
    };
  }
}
