import { createHash, randomUUID } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RequestContext } from '@los/contracts';
import { DomainError } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { findAllowedType } from './file-type';
import { OBJECT_STORAGE, type ObjectStorage } from './storage';

export interface UploadedFile { originalname: string; mimetype: string; buffer: Buffer; size: number }
export interface FileView { id: string; name: string; mime: string; size: number; sha256: string; uploadedBy: string | null; createdAt: string }

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const maxFileBytes = (env: NodeJS.ProcessEnv = process.env) => Number(env.FILE_MAX_BYTES ?? DEFAULT_MAX_BYTES);

/** Сервисийн нэрээр (харилцагчийн эзэмшлийг дуудагч өөрөө шалгасан) хандах дотоод хэрэглэгч, жишээ нь `svc:origination-portal`. */
const SERVICE_USER_PREFIX = 'svc:';

/**
 * Файлын агуулга татах эрх (security, NFR-3): ЗӨВХӨН дотоод сервис (`svc:` хэрэглэгч, харилцагчийн контекстгүй) — жишээ нь `svc:origination-files`
 * (ажилтан), `svc:origination-portal` (харилцагч). dms хүсэлт/салбарыг мэдэхгүй тул ажилтан агуулгыг origination-оор
 * (`GET /api/applications/:id/files/:fileId/content`: хүсэлтийн хүрээ + файлын холбоос шалгасан) татна. Байгууллагын хязгаарлалтыг `find` өмнө нь шалгасан (өөр org → 404).
 */
export function canReadFileContent(ctx: Pick<RequestContext, 'userId' | 'customerId'>): boolean {
  if (ctx.customerId) return false;
  return !!ctx.userId?.startsWith(SERVICE_USER_PREFIX);
}

/** Нэр: зам, удирдлагын тэмдэгт, `..`-гүй; multer UTF-8 нэрийг latin1 гэж задалдаг тул буцаан засна (монгол нэр). */
export function cleanFileName(original: string): string {
  const utf8 = Buffer.from(original, 'latin1').toString('utf8');
  const base = (utf8.includes('\uFFFD') ? original : utf8).split(/[\\/]/).pop()!.replace(/["<>|:*?]/g, '_').replace(/^\.+/, '').trim().slice(0, 200);
  const name = [...base].map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? '_' : ch)).join('');
  return name || 'file';
}

/** Файл сан (docs/01 §9, docs/03 `file`). Агуулга нь MinIO-д, мета нь `dms.file`-д. Зөвхөн өөрийн байгууллагын файл харагдана. */
@Injectable()
export class FileService {
  constructor(private readonly db: PrismaService, @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {}

  async upload(ctx: RequestContext, f: UploadedFile | undefined): Promise<FileView> {
    if (!f?.buffer?.length) throw new DomainError('FILE_REQUIRED', 'Файл сонгоогүй эсвэл хоосон байна', 400);
    if (f.size > maxFileBytes()) throw new DomainError('FILE_TOO_LARGE', `Файлын хэмжээ ${Math.round(maxFileBytes() / 1048576)}MB-аас хэтэрсэн`, 413);
    const name = cleanFileName(f.originalname);
    const type = findAllowedType(f.mimetype);
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
    if (!type || !type.ext.includes(ext)) throw new DomainError('FILE_TYPE_NOT_ALLOWED', 'Энэ төрлийн файл зөвшөөрөгдөөгүй (PDF, PNG, JPG, DOCX, XLSX, CSV, TXT)', 415);
    if (!type.sniff(f.buffer)) throw new DomainError('FILE_CONTENT_MISMATCH', 'Файлын агуулга өргөтгөлтэй нийцэхгүй байна', 415);

    const sha256 = createHash('sha256').update(f.buffer).digest('hex');
    const now = new Date();
    const storageKey = `${ctx.orgId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
    await this.storage.put(storageKey, f.buffer, type.mime);
    try {
      const row = await this.db.file.create({ data: { orgId: ctx.orgId, bucket: this.storage.bucket, storageKey, name, mime: type.mime, size: f.size, sha256, uploadedBy: ctx.userId, createdBy: ctx.userId } });
      return view(row);
    } catch (e) {
      await this.storage.remove(storageKey).catch(() => undefined); // DB бичихгүй бол өнчин объект үлдээхгүй
      throw e;
    }
  }

  async meta(ctx: RequestContext, id: string): Promise<FileView> {
    return view(await this.find(ctx, id));
  }

  /** Дотоод унших (жишээ нь гэрээний загвар үүсгэх): зөвхөн байгууллага. HTTP-ийн эрхийн шалгалт `download`-д. */
  async open(ctx: RequestContext, id: string) {
    const row = await this.find(ctx, id);
    return { row, stream: await this.storage.get(row.storageKey) };
  }

  /** `GET /files/:id/content`: эхлээд байгууллага (404) — эрхгүй ч гэсэн өөр байгууллагын id-г 403-аар илрүүлэхгүй; дараа нь `canReadFileContent` (403). */
  async download(ctx: RequestContext, id: string) {
    const row = await this.find(ctx, id);
    if (!canReadFileContent(ctx)) throw new ForbiddenException({ code: 'FILE_ACCESS_DENIED', message: 'Энэ файлыг татах эрх хүрэхгүй' });
    return { row, stream: await this.storage.get(row.storageKey) };
  }

  private async find(ctx: RequestContext, id: string) {
    const row = /^[0-9a-f-]{36}$/i.test(id) ? await this.db.file.findFirst({ where: { id, orgId: ctx.orgId, purgedAt: null } }) : null;
    if (!row) throw new NotFoundException({ code: 'FILE_NOT_FOUND', message: 'Файл олдсонгүй' });
    return row;
  }
}

const view = (r: { id: string; name: string; mime: string; size: number; sha256: string; uploadedBy: string | null; createdAt: Date }): FileView =>
  ({ id: r.id, name: r.name, mime: r.mime, size: r.size, sha256: r.sha256, uploadedBy: r.uploadedBy, createdAt: r.createdAt.toISOString() });
