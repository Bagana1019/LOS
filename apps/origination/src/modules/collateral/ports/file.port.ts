import { z } from 'zod';
import type { RequestContext } from '@los/contracts';
import { DomainError, type InternalHttpClient } from '@los/nest-common';
import { INTERNAL_TIMEOUT_MS, callUpstream, createInternalHttp } from './upstream';

/** dms файлын мета (барьцааны баримт, гадны үнэлгээний тайлан шалгахад). `apps/dms/src/modules/file` `FileView`-ийн хэрэгтэй хэсэг. */
export const DmsFileMeta = z.object({ id: z.string(), name: z.string(), mime: z.string(), size: z.number().int().nonnegative() }).passthrough();
export type FileMeta = Pick<z.infer<typeof DmsFileMeta>, 'id' | 'name' | 'mime' | 'size'>;

/** origination → dms (sync REST). Файл олдохгүй (эсвэл өөр байгууллагын) бол `null`. Тестэд солигдоно. */
export interface FilePort {
  getMeta(ctx: RequestContext, fileId: string): Promise<FileMeta | null>;
}
export const FILE_PORT = Symbol('FILE_PORT');

export class HttpFilePort implements FilePort {
  constructor(private readonly http: InternalHttpClient = createInternalHttp(), private readonly timeoutMs: number = INTERNAL_TIMEOUT_MS) {}

  async getMeta(ctx: RequestContext, fileId: string): Promise<FileMeta | null> {
    try {
      const f = await callUpstream('dms', () => this.http.get('dms', `/api/files/${encodeURIComponent(fileId)}`, { ctx, timeoutMs: this.timeoutMs, schema: DmsFileMeta }));
      return { id: f.id, name: f.name, mime: f.mime, size: f.size };
    } catch (e) {
      if (e instanceof DomainError && e.getStatus() === 404) return null;
      throw e;
    }
  }
}

export const createFilePort = (): FilePort => new HttpFilePort();
