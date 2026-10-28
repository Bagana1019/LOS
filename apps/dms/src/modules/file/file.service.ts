import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RequestContext } from '@los/contracts';
import { DomainError } from '@los/nest-common';
import { PrismaService } from '../../prisma.service';
import { findAllowedType } from './file-type';
import { OBJECT_STORAGE, type ObjectStorage } from './storage';

export interface UploadedFile { originalname: string; mimetype: string; buffer: Buffer; size: number }
export interface FileView { id: string; name: string; mime: string; size: number; sha256: string; uploadedBy: string | null; createdAt: string }

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const maxFileBytes = (env: NodeJS.ProcessEnv = process.env) => Number(env.FILE_MAX_BYTES ?? DEFAULT_MAX_BYTES);

/** Нэр: зам, удирдлагын тэмдэгт, `..`-гүй; multer UTF-8 нэрийг latin1 гэж задалдаг тул буцаан засна (монгол нэр). */
export function cleanFileName(original: string): string {
  const utf8 = Buffer.from(original, 'latin1').toString('utf8');
  const name = (utf8.includes('�') ? original : utf8).split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').replace(/^\.+/, '').trim().slice(0, 200);
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

  async open(ctx: RequestContext, id: string) {
    const row = await this.find(ctx, id);
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
