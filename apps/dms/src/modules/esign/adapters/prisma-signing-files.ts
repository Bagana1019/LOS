// SigningFiles port-ыг main-ийн DMS файл сан (`dms.file` + OBJECT_STORAGE) дээр хэрэгжүүлнэ. Файл БҮРИЙН org шалгагдана
// (өөр байгууллагын файлыг унших/гарын үсгийн эх болгох боломжгүй), унших бүрт хэмжээ + sha256 тулгагдана.
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma.service';
import { OBJECT_STORAGE, type ObjectStorage } from '../../file/storage';
import {
  FileIntegrityError, FileNotFoundError, type SaveSigningFileInput, type SigningFileContent, type SigningFiles,
} from '../ports/signing-files.port';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function collect(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

@Injectable()
export class PrismaSigningFiles implements SigningFiles {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async read(orgId: string, fileId: string): Promise<SigningFileContent> {
    const row = UUID.test(fileId) ? await this.db.file.findFirst({ where: { id: fileId, orgId, purgedAt: null } }) : null;
    if (!row) throw new FileNotFoundError(fileId);
    let bytes: Buffer;
    try {
      bytes = await collect(await this.storage.get(row.storageKey));
    } catch (error) {
      if ((error as { code?: string } | null)?.code === 'NoSuchKey') throw new FileIntegrityError(fileId, 'CONTENT_MISSING');
      throw error;
    }
    if (bytes.length !== row.size) throw new FileIntegrityError(fileId, 'SIZE_MISMATCH');
    if (sha256Hex(bytes) !== row.sha256) throw new FileIntegrityError(fileId, 'CHECKSUM_MISMATCH');
    return { id: row.id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, bytes };
  }

  /** Системийн үүсгэсэн файл (гарын үсэгтэй PDF, .p7s): хэрэглэгчийн upload-ын төрлийн шүүлтүүрээс гадуур. DB бичихгүй бол объектыг устгана */
  async save(input: SaveSigningFileInput): Promise<{ id: string; sha256: string; size: number }> {
    const now = new Date();
    const storageKey = `${input.orgId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
    const sha256 = sha256Hex(input.bytes);
    await this.storage.put(storageKey, input.bytes, input.mime);
    try {
      const row = await this.db.file.create({
        data: { orgId: input.orgId, bucket: this.storage.bucket, storageKey, name: input.name, mime: input.mime, size: input.bytes.length, sha256, uploadedBy: input.uploadedBy, createdBy: input.uploadedBy },
      });
      return { id: row.id, sha256, size: input.bytes.length };
    } catch (error) {
      await this.storage.remove(storageKey).catch(() => undefined);
      throw error;
    }
  }
}
