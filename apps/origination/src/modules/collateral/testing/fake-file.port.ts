import type { RequestContext } from '@los/contracts';
import type { FileMeta, FilePort } from '../ports/file.port';

/** Тестийн FilePort: бүртгэсэн файл л олдоно. Анхдагчаар файлыг дуудагч өөрөө байршуулсан (upload → attach урсгал); өөр хүнийх бол `add({ uploadedBy })`. */
export class FakeFilePort implements FilePort {
  readonly files = new Map<string, FileMeta>();
  private readonly uploaders = new Map<string, string | null>();
  readonly calls: string[] = [];
  /** Дараагийн дуудлагад шидэх алдаа (dms унасан үед). */
  failWith: Error | null = null;

  add(meta: Partial<FileMeta> & { id: string }): FileMeta {
    const { uploadedBy, ...rest } = meta;
    const full: FileMeta = { name: 'file.pdf', mime: 'application/pdf', size: 1234, uploadedBy: null, ...rest };
    this.files.set(full.id, full);
    if (uploadedBy !== undefined) this.uploaders.set(full.id, uploadedBy);
    return full;
  }

  reset(): void {
    this.files.clear();
    this.uploaders.clear();
    this.calls.length = 0;
    this.failWith = null;
  }

  async getMeta(ctx: RequestContext, fileId: string): Promise<FileMeta | null> {
    this.calls.push(fileId);
    if (this.failWith) throw this.failWith;
    const meta = this.files.get(fileId);
    if (!meta) return null;
    return { ...meta, uploadedBy: this.uploaders.has(fileId) ? (this.uploaders.get(fileId) ?? null) : ctx.userId };
  }
}
