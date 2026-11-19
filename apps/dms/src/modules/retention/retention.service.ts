import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../file/storage';

/**
 * dms-д entity төрлийг найдвартай мэдэх цорын ганц ангилал: `dms.document`-д хавсаргасан файл = хүсэлтийн баримт.
 * Хавсаргаагүй файлыг (харилцагчийн зураг гэх мэт — өөр сервис id-аар нь хадгалдаг, dms харахгүй) ХЭЗЭЭ Ч устгахгүй.
 */
export const APPLICATION_DOCUMENT = 'APPLICATION_DOCUMENT';

export interface SweepResult { stamped: number; purged: number; failed: number; skipped: number }

interface Candidate { id: string; storage_key: string }

/**
 * M10 (FR-11/NFR, docs/03 `retention_policy`): 1) `retention_until`-г бодлогоос тооцно (байршуулсан огноо + `retention_years`);
 * 2) хугацаа дууссан, `auto_delete=true`, legal hold-гүй, гэрээний загварт ашиглагдаагүй файлын объектыг устгаж `purged_at` тэмдэглэнэ.
 * Idempotent: `purged_at IS NULL` нөхцөлтэй; объект устгаж чадаагүй бол мөрийг тэмдэглэхгүй (дараагийн tick дахин оролдоно).
 */
@Injectable()
export class RetentionService {
  constructor(private readonly db: PrismaService, @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  async sweep(now: Date, batch: number): Promise<SweepResult> {
    const stamped = await this.stamp(batch);
    const candidates = await this.db.$queryRaw<Candidate[]>`
      SELECT f.id, f.storage_key FROM dms.file f
      JOIN dms.retention_policy p ON p.org_id = f.org_id AND p.entity_type = ${APPLICATION_DOCUMENT} AND p.auto_delete
      WHERE f.purged_at IS NULL AND NOT f.legal_hold AND f.retention_until <= ${now}
        AND f.bucket = ${this.storage.bucket} -- өөр (хуучин) bucket-ийн объектыг энэ instance устгаж чадахгүй; batch-ийг эзлэхгүй
        AND EXISTS (SELECT 1 FROM dms.document d WHERE d.file_id = f.id)
        AND NOT EXISTS (SELECT 1 FROM dms.contract_template t WHERE t.docx_file_id = f.id)
      ORDER BY f.retention_until, f.id
      LIMIT ${batch}`;
    const result: SweepResult = { stamped, purged: 0, failed: 0, skipped: 0 };
    for (const c of candidates) {
      const outcome = await this.purgeOne(c, now);
      result[outcome] += 1;
    }
    return result;
  }

  /** `retention_until`-гүй хавсаргасан файлд бодлогын хугацааг бичнэ (бодлого байгаа org-д л). */
  private stamp(batch: number): Promise<number> {
    return this.db.$executeRaw`
      UPDATE dms.file f SET retention_until = f.created_at + make_interval(years => p.retention_years), updated_at = now()
      FROM dms.retention_policy p
      WHERE p.org_id = f.org_id AND p.entity_type = ${APPLICATION_DOCUMENT}
        AND f.id IN (
          SELECT f2.id FROM dms.file f2
          WHERE f2.retention_until IS NULL AND f2.purged_at IS NULL
            AND EXISTS (SELECT 1 FROM dms.document d WHERE d.file_id = f2.id)
            AND EXISTS (SELECT 1 FROM dms.retention_policy p2 WHERE p2.org_id = f2.org_id AND p2.entity_type = ${APPLICATION_DOCUMENT})
          ORDER BY f2.created_at, f2.id
          LIMIT ${batch})`;
  }

  private async purgeOne(c: Candidate, now: Date): Promise<'purged' | 'failed' | 'skipped'> {
    try {
      await this.storage.remove(c.storage_key); // MinIO removeObject нь байхгүй объектод ч амжилттай (давтан ажиллахад аюулгүй)
    } catch {
      return 'failed';
    }
    const n = await this.db.$executeRaw`UPDATE dms.file SET purged_at = ${now}, updated_at = now() WHERE id = ${c.id} AND purged_at IS NULL`;
    return n === 1 ? 'purged' : 'skipped';
  }
}
