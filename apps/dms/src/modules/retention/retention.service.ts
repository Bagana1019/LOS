import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '.prisma/client-dms';
import { PrismaService } from '../../prisma.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../file/storage';

/**
 * dms-д entity төрлийг найдвартай мэдэх цорын ганц ангилал: `dms.document`-д хавсаргасан файл = хүсэлтийн баримт.
 * Хавсаргаагүй файлыг (харилцагчийн зураг гэх мэт — өөр сервис id-аар нь хадгалдаг, dms харахгүй) ХЭЗЭЭ Ч устгахгүй.
 */
export const APPLICATION_DOCUMENT = 'APPLICATION_DOCUMENT';

export interface FileReference { table: string; column: string; note: string }

/** Бодлогын «эзэн» лавлагаа: retention_policy зөвхөн үүгээр хамаарна (EXISTS шаардлагатай). */
export const RETENTION_ANCHOR: FileReference = { table: 'document', column: 'file_id', note: 'хүсэлтийн баримт — APPLICATION_DOCUMENT бодлогын эзэн' };

/**
 * `dms.file.id`-г заадаг БҮХ багана — ЦОРЫН ГАНЦ жагсаалт. Шинэ багана нэмбэл ЭНД бүртгэ (`test/retention.e2e.test.ts` FK болон `*file_id`
 * баганыг DB-ээс уншиж энэ жагсаалттай тулгана — бүртгээгүй бол тест унана). Эзэн (`document`)-ээс бусад лавлагаатай файл хэзээ ч устгагдахгүй.
 */
export const FILE_REFERENCES: readonly FileReference[] = [
  RETENTION_ANCHOR,
  { table: 'contract_template', column: 'docx_file_id', note: 'гэрээний загвар (FK)' },
  { table: 'signing_request', column: 'source_file_id', note: 'цахим гарын үсгийн эх PDF (FK-гүй)' },
  { table: 'signing_request', column: 'signed_file_id', note: 'гарын үсэг зурсан PDF (FK-гүй)' },
  { table: 'signing_request', column: 'signature_file_id', note: 'гарын үсгийн зураг (FK-гүй)' },
];

const IDENT = /^[a-z_]+$/;
for (const r of FILE_REFERENCES) if (!IDENT.test(r.table) || !IDENT.test(r.column)) throw new Error(`invalid FILE_REFERENCES entry ${r.table}.${r.column}`);

/** Эзнээс бусад лавлагаа байхгүй (тогтмол нэрс — хэрэглэгчийн оролт биш, дээр шалгасан). */
const NOT_REFERENCED_ELSEWHERE = Prisma.raw(
  FILE_REFERENCES.filter((r) => r !== RETENTION_ANCHOR)
    .map((r) => `NOT EXISTS (SELECT 1 FROM dms.${r.table} x WHERE x.${r.column} = f.id)`)
    .join(' AND '),
);

export interface SweepResult { stamped: number; purged: number; failed: number; skipped: number }

interface Candidate { id: string; storage_key: string }

/**
 * M10 (FR-11/NFR, docs/03 `retention_policy`): 1) `retention_until`-г бодлогоос тооцно (байршуулсан огноо + `retention_years`);
 * 2) хугацаа дууссан + `auto_delete=true` + legal hold-гүй + эзнээс бусад лавлагаагүй файлыг устгана.
 * Файл бүр тусдаа транзакц: мөрийг `FOR UPDATE SKIP LOCKED`-оор түгжиж бүх нөхцөлийг ДАХИН шалгана → `purged_at` → эцэст нь storage-оос устгана
 * (storage алдаа → rollback, мөр хэвээр; commit-оос өмнө унавал дараагийн tick idempotent устгалыг давтана). FK-тэй лавлагааг шинээр
 * үүсгэх нь энэ түгжээг хүлээнэ.
 */
@Injectable()
export class RetentionService {
  constructor(private readonly db: PrismaService, @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  async sweep(now: Date, batch: number): Promise<SweepResult> {
    const stamped = await this.stamp(batch);
    const candidates = await this.db.$queryRaw<Candidate[]>(this.purgeable(now, Prisma.sql`ORDER BY f.retention_until, f.id LIMIT ${batch}`));
    const result: SweepResult = { stamped, purged: 0, failed: 0, skipped: 0 };
    for (const c of candidates) result[await this.purgeOne(c.id, now)] += 1;
    return result;
  }

  /** Устгаж болох файлын нөхцөл (сонголт ба түгжсэн дахин шалгалт хоёуланд ИЖИЛ). */
  private purgeable(now: Date, tail: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
      SELECT f.id, f.storage_key FROM dms.file f
      JOIN dms.retention_policy p ON p.org_id = f.org_id AND p.entity_type = ${APPLICATION_DOCUMENT} AND p.auto_delete
      WHERE f.purged_at IS NULL AND NOT f.legal_hold AND f.retention_until <= ${now}
        AND f.bucket = ${this.storage.bucket}
        AND EXISTS (SELECT 1 FROM dms.document d WHERE d.file_id = f.id)
        AND ${NOT_REFERENCED_ELSEWHERE}
      ${tail}`;
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

  private async purgeOne(id: string, now: Date): Promise<'purged' | 'failed' | 'skipped'> {
    try {
      return await this.db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Candidate[]>(this.purgeable(now, Prisma.sql`AND f.id = ${id} FOR UPDATE OF f SKIP LOCKED`));
        const target = locked[0];
        if (!target) return 'skipped' as const; // өөр pod түгжсэн, эсвэл сонгосноос хойш лавлагаа/hold нэмэгдсэн
        await tx.$executeRaw`UPDATE dms.file SET purged_at = ${now}, updated_at = now() WHERE id = ${id}`;
        await this.storage.remove(target.storage_key); // СҮҮЛД: алдаа гарвал rollback (мөр хэвээр); MinIO-д байхгүй объектыг устгах нь амжилттай
        return 'purged' as const;
      });
    } catch {
      return 'failed';
    }
  }
}
