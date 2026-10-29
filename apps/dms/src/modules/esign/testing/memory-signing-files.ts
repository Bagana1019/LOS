// Тестэд: SigningFiles-ийн санах ойн гүйцэтгэл (production-д ашиглагдахгүй). PrismaSigningFiles-тай ижил гэрээ — org тусгаарлалт,
// унших бүрт хэмжээ + sha256 тулгалт. `storage` нь объектыг шууд хөндөж (устгах/эвдэх) тест хийхэд зориулагдсан.
import { createHash, randomUUID } from 'node:crypto';
import {
  FileIntegrityError, FileNotFoundError, type SaveSigningFileInput, type SigningFileContent, type SigningFiles,
} from '../ports/signing-files.port';

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface Row { id: string; orgId: string; name: string; mime: string; size: number; sha256: string; key: string }

export class MemoryObjectBucket {
  private readonly objects = new Map<string, { bytes: Buffer; mime: string }>();
  keys(): string[] { return [...this.objects.keys()]; }
  async put(key: string, bytes: Buffer, mime: string): Promise<void> { this.objects.set(key, { bytes: Buffer.from(bytes), mime }); }
  async get(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey' });
    return Buffer.from(object.bytes);
  }
  delete(key: string): void { this.objects.delete(key); }
}

export class MemorySigningFiles implements SigningFiles {
  readonly storage = new MemoryObjectBucket();
  private readonly rows = new Map<string, Row>();

  /** Тестийн эх файл (гарын үсэггүй гэрээ) оруулах. `orgId` default: 'org-1' */
  async put(input: Omit<SaveSigningFileInput, 'orgId'> & { orgId?: string }): Promise<{ id: string; sha256: string; size: number }> {
    return this.save({ orgId: 'org-1', ...input });
  }

  async save(input: SaveSigningFileInput): Promise<{ id: string; sha256: string; size: number }> {
    const id = randomUUID();
    const key = `${input.orgId}/${randomUUID()}`;
    const sha256 = sha256Hex(input.bytes);
    await this.storage.put(key, input.bytes, input.mime);
    this.rows.set(id, { id, orgId: input.orgId, name: input.name, mime: input.mime, size: input.bytes.length, sha256, key });
    return { id, sha256, size: input.bytes.length };
  }

  async read(orgId: string, fileId: string): Promise<SigningFileContent> {
    const content = await this.getContent(fileId);
    if (this.rows.get(fileId)?.orgId !== orgId) throw new FileNotFoundError(fileId);
    return content;
  }

  /** org шалгахгүй (тестийн шууд унших) */
  async getContent(fileId: string): Promise<SigningFileContent> {
    const row = this.rows.get(fileId);
    if (!row) throw new FileNotFoundError(fileId);
    let bytes: Buffer;
    try {
      bytes = await this.storage.get(row.key);
    } catch {
      throw new FileIntegrityError(fileId, 'CONTENT_MISSING');
    }
    if (bytes.length !== row.size) throw new FileIntegrityError(fileId, 'SIZE_MISMATCH');
    if (sha256Hex(bytes) !== row.sha256) throw new FileIntegrityError(fileId, 'CHECKSUM_MISMATCH');
    return { id: row.id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, bytes };
  }
}
