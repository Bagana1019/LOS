import { z } from 'zod';
import { SigningRequestView, type CreateSigningRequest, type RequestContext } from '@los/contracts';
// origination → dms sync REST (CLAUDE.md §3.2.2). dms-ийн `SigningRequestView` ба `CreateSigningRequest` DTO-г @los/contracts-оос авна.
// Байгууллага (X-Org-Id), хэрэглэгч, эрх, correlationId нь ажилтны контекстоос толгойгоор дамжина — body-д orgId байхгүй.

/** create/resend хариунд `signingUrl` заавал байна (токен DB-д хадгалагдахгүй тул зөвхөн энэ хоёр дуудлагад л гарна) */
export const IssuedSigningRequest = SigningRequestView.extend({ signingUrl: z.string().url() });
export type IssuedSigningRequest = z.infer<typeof IssuedSigningRequest>;

export interface EsignGateway {
  /** Идэвхтэй хүсэлт байвал ConflictException */
  createRequest(input: CreateSigningRequest, ctx: RequestContext): Promise<IssuedSigningRequest>;
  /** Токен шинэчилнэ (хуучин линк тэр дор нь хүчингүй). Идэвхтэй биш бол ConflictException */
  resend(signingRequestId: string, ctx: RequestContext): Promise<IssuedSigningRequest>;
  cancel(signingRequestId: string, ctx: RequestContext): Promise<SigningRequestView>;
  /** `signingUrl`-гүй */
  get(signingRequestId: string, ctx: RequestContext): Promise<SigningRequestView>;
}
export const ESIGN_GATEWAY = Symbol('ESIGN_GATEWAY');
