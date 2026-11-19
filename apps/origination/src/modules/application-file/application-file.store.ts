import { z } from 'zod';
import type { RequestContext } from '@los/contracts';
import { InternalHttpClient } from '@los/nest-common';
import { callUpstream } from '../collateral/ports/upstream';

/**
 * origination → dms (CLAUDE.md §3.2.2): хүсэлтийн файлын байт. dms ажилтны хүсэлт/салбарыг мэдэхгүй — эзэмшлийг ЭНД шалгасны дараа л
 * сервисийн нэрээр (`svc:` угтвар = dms `canReadFileContent`) дуудна. Ажилтан dms-ийн агуулгын замд шууд хүрэхгүй.
 */
export const FILE_STORE_SERVICE_USER = 'svc:origination-files';
export const APPLICATION_FILE_STORE = Symbol('APPLICATION_FILE_STORE');

const FILE_TIMEOUT_MS = 15_000;
const FileMeta = z.object({ name: z.string(), mime: z.string() });

export interface StoredFile { name: string; mime: string; content: Buffer }
export interface ApplicationFileStorePort {
  fetch(ctx: RequestContext, fileId: string): Promise<StoredFile>;
}

export class HttpApplicationFileStore implements ApplicationFileStorePort {
  constructor(private readonly http = new InternalHttpClient()) {}

  async fetch(ctx: RequestContext, fileId: string): Promise<StoredFile> {
    const serviceCtx: RequestContext = { userId: FILE_STORE_SERVICE_USER, roles: [], branchId: null, orgId: ctx.orgId, customerId: null, correlationId: ctx.correlationId };
    const path = `/api/files/${encodeURIComponent(fileId)}`;
    const [meta, content] = await callUpstream('dms', () => Promise.all([
      this.http.get<unknown>('dms', path, { ctx: serviceCtx, timeoutMs: FILE_TIMEOUT_MS }),
      this.http.get<Buffer>('dms', `${path}/content`, { ctx: serviceCtx, responseType: 'buffer', timeoutMs: FILE_TIMEOUT_MS }),
    ]));
    return { ...FileMeta.parse(meta), content };
  }
}
