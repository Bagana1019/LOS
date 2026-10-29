import type { RequestContext } from './request-context';

// @types/express суулгаагүй тул controller/guard/filter-д хэрэгтэй хамгийн бага хэлбэр.
export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
  ctx?: RequestContext;
}
export interface HttpResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): HttpResponse;
  json(body: unknown): unknown;
}
