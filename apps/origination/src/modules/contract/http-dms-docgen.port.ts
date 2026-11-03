import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { RenderTemplateResponse, type ContractTemplateType, type RenderTemplateRequest, type RequestContext } from '@los/contracts';
import { DomainError, InternalHttpClient } from '@los/nest-common';
import type { DmsDocgenPort } from './dms-docgen.port';

/** Гэрээний PDF үүсгэх нь урт ажил (хөрвүүлэлт) — гадаад зэрэглэлийн 15с (CLAUDE.md §3.1). */
export const DMS_RENDER_TIMEOUT_MS = 15_000;
export const DMS_LOOKUP_TIMEOUT_MS = 3_000;
const noRedirectFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });

export function createDmsDocgen(env: NodeJS.ProcessEnv = process.env): HttpDmsDocgen {
  return new HttpDmsDocgen(new InternalHttpClient({ env, fetchFn: noRedirectFetch }));
}

export class HttpDmsDocgen implements DmsDocgenPort {
  constructor(private readonly http: InternalHttpClient) {}

  async render(req: RenderTemplateRequest, ctx: RequestContext) {
    // 422 (загвар тохируулаагүй, буруу) — мессежийг дамжуулна; бусад 4xx → 502
    const json = await this.http.post('dms', '/api/templates/render', req, { ctx, timeoutMs: DMS_RENDER_TIMEOUT_MS });
    const parsed = RenderTemplateResponse.safeParse(json);
    if (!parsed.success) throw new BadGatewayException('DMS үйлчилгээ хүсэлтийг биелүүлж чадсангүй');
    return parsed.data;
  }

  async fileExists(fileId: string, ctx: RequestContext): Promise<boolean> {
    try {
      await this.http.get('dms', `/api/files/${encodeURIComponent(fileId)}`, { ctx, timeoutMs: DMS_LOOKUP_TIMEOUT_MS });
      return true;
    } catch (e) {
      if (e instanceof NotFoundException || (e instanceof DomainError && e.getStatus() === 404)) return false;
      throw e;
    }
  }

  async hasTemplate(type: ContractTemplateType, productId: string | null, ctx: RequestContext): Promise<boolean> {
    const qs = (p: string | null) => `type=${type}&activeOnly=true${p ? `&productId=${encodeURIComponent(p)}` : ''}`;
    for (const p of productId ? [productId, null] : [null]) {
      const r = (await this.http.get('dms', `/api/templates?${qs(p)}`, { ctx, timeoutMs: DMS_LOOKUP_TIMEOUT_MS })) as { items?: Array<{ productId: string | null }> };
      if (r.items?.some((t) => t.productId === p)) return true;
    }
    return false;
  }
}
