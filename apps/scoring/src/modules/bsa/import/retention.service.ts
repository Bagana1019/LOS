// BSA-BR-8: хуулга, гүйлгээний өгөгдлийг settings.retentionYears (анхдагч 3 жил) хадгалж, дараа нь автоматаар бүрэн устгана.
//  - Дараалал: DB-ээс устгах (repo.retention.purge — өөрөө атом, commit хийнэ) ⇒ ДАРАА нь object store-оос файлууд. Файл эхлээд уствал DB
//    устгал амжилтгүй болсон үед шинжилгээ файлгүй үлдэнэ. Давтан гүйлт аюулгүй: устсан шинжилгээ олдохгүй (алгасна).
//  - Хязгаарлалт (ObjectStore-д list() байхгүй): DB commit-ийн дараа процесс унавал тэр шинжилгээний файлууд «өнчин» үлдэнэ — дахин гүйлтээр
//    олдохгүй. Object store-ийн prefix sweep (bsa/<org>/<analysis>/) шаардлагатай — README-д open issue.
//  - Лог: зөвхөн тоо. Объектын түлхүүр, шинжилгээний id-г бичихгүй.
//  - Org бүрийн retentionYears өөр байж болно: нээлтийн тасалбар = now − retentionDiscoveryMinYears, дараа нь org-ийн өөрийн тохиргоогоор шүүнэ.
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { describeError } from '../common/import-queue';
import { BSA_SETTINGS, OBJECT_STORE, type BsaSettingsProvider, type ObjectStore } from '../common/infra.ports';
import { BSA_REPOSITORY, BsaNotFoundError, type BsaRepository, type ExpiredAnalysisRef } from '../common/persistence';
import { BSA_CLOCK, BSA_IMPORT_OPTIONS, type Clock, type ImportOptions } from './import.defaults';

export interface RetentionReport {
  /** Нээлтээр олдсон (хугацаа хэтэрсэн байж болзошгүй) шинжилгээ */
  examined: number;
  /** DB-ээс бүрэн устгасан */
  purged: number;
  /** Object store-оос устгасан файл */
  objectsDeleted: number;
  /** Устгаж чадаагүй файл (өнчин үлдсэн; дахин оролдохгүй) */
  objectFailures: number;
}

/** Нээлтийн дуудлагын дээд өргөтгөл: org-ийн хугацаа өөр тул шүүгдсэн мөр хоосон болохоос сэргийлж limit-ийг ихэсгэх дээд үржвэр */
const MAX_PROBE_MULTIPLIER = 16;

/** `years` жилийн өмнөх огноо. 2-р сарын 29 нь жил дамжихад 28 болно (March 1 биш): хадгалах хугацааг хэзээ ч богиносгохгүй */
export function subtractYears(now: Date, years: number): Date {
  const d = new Date(now.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(BSA_REPOSITORY) private readonly repo: BsaRepository,
    @Inject(BSA_SETTINGS) private readonly settingsProvider: BsaSettingsProvider,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(BSA_IMPORT_OPTIONS) private readonly options: ImportOptions,
    @Inject(BSA_CLOCK) private readonly clock: Clock,
  ) {}

  /** Env BSA_RETENTION_INTERVAL_MS > 0 үед тогтмол хугацаанд ажиллана. 0 = унтраалттай (гаднаас purgeExpired дуудна) */
  onModuleInit(): void {
    if (this.options.retentionIntervalMs <= 0 || this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.options.retentionIntervalMs);
    this.timer.unref(); // процессыг барьж үлдэхгүй
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // өмнөх гүйлт дуусаагүй
    this.running = true;
    try {
      const report = await this.purgeExpired();
      if (report.purged > 0 || report.objectFailures > 0) {
        this.log.log(`retention: purged=${report.purged} objectsDeleted=${report.objectsDeleted} objectFailures=${report.objectFailures}`);
      }
    } catch (e) {
      this.log.error(`retention run failed (${describeError(e)})`);
    } finally {
      this.running = false;
    }
  }

  /** Хугацаа нь дууссан шинжилгээнүүдийг (хамгийн ихдээ `limit`) устгана. Системийн ажил: хэрэглэгчийн контекстгүй */
  async purgeExpired(now: Date = this.clock.now(), limit: number = this.options.retentionBatchSize): Promise<RetentionReport> {
    const expired = await this.findExpired(now, limit);
    const report: RetentionReport = { examined: expired.examined, purged: 0, objectsDeleted: 0, objectFailures: 0 };
    for (const ref of expired.items) {
      let keys: string[];
      try {
        keys = (await this.repo.retention.purge(ref.id)).objectKeys; // DB commit энд
      } catch (e) {
        if (e instanceof BsaNotFoundError) continue; // зэрэгцээ гүйлт эсвэл өмнө нь устсан — идемпотент
        throw e;
      }
      report.purged++;
      for (const key of keys) {
        try {
          await this.store.delete(key);
          report.objectsDeleted++;
        } catch (e) {
          report.objectFailures++;
          this.log.warn(`retention: object delete failed (${describeError(e)})`);
        }
      }
    }
    return report;
  }

  /** Нээлт: хамгийн өргөн (бага жилийн) тасалбараар олоод org бүрийн retentionYears-ээр шүүнэ */
  private async findExpired(now: Date, limit: number): Promise<{ items: ExpiredAnalysisRef[]; examined: number }> {
    const discovery = subtractYears(now, this.options.retentionDiscoveryMinYears);
    const yearsByOrg = new Map<string, number>();
    const yearsOf = async (orgId: string): Promise<number> => {
      let y = yearsByOrg.get(orgId);
      if (y === undefined) {
        y = (await this.settingsProvider.get(orgId)).retentionYears;
        yearsByOrg.set(orgId, y);
      }
      return y;
    };
    let probe = limit;
    for (;;) {
      const batch = await this.repo.retention.findExpired(discovery, probe);
      const due: ExpiredAnalysisRef[] = [];
      for (const ref of batch) {
        if (ref.createdAt.getTime() < subtractYears(now, await yearsOf(ref.orgId)).getTime()) due.push(ref);
      }
      const exhausted = batch.length < probe;
      if (due.length >= limit || exhausted || probe >= limit * MAX_PROBE_MULTIPLIER) {
        return { items: due.slice(0, limit), examined: batch.length };
      }
      probe *= 2;
    }
  }
}
