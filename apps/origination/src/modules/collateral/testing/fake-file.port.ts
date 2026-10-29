import type { RequestContext } from '@los/contracts';
import type { FileMeta, FilePort } from '../ports/file.port';

/** Тестийн FilePort: бүртгэсэн файл л олдоно. */
export class FakeFilePort implements FilePort {
  readonly files = new Map<string, FileMeta>();
  readonly calls: string[] = [];
  /** Дараагийн дуудлагад шидэх алдаа (dms унасан үед). */
  failWith: Error | null = null;

  add(meta: Partial<FileMeta> & { id: string }): FileMeta {
    const full: FileMeta = { name: 'file.pdf', mime: 'application/pdf', size: 1234, ...meta };
    this.files.set(full.id, full);
    return full;
  }

  reset(): void {
    this.files.clear();
    this.calls.length = 0;
    this.failWith = null;
  }

  async getMeta(_ctx: RequestContext, fileId: string): Promise<FileMeta | null> {
    this.calls.push(fileId);
    if (this.failWith) throw this.failWith;
    return this.files.get(fileId) ?? null;
  }
}
