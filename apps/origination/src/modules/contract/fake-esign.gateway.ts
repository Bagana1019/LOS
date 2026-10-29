import { ConflictException, NotFoundException } from '@nestjs/common';
import type { CreateSigningRequest, RequestContext, SigningRequestView, SigningStatus } from '@los/contracts';
import type { EsignGateway, IssuedSigningRequest } from './esign.gateway';
import { maskPhone } from './pii';

type Op = 'createRequest' | 'resend' | 'cancel' | 'get';
const ACTIVE: readonly SigningStatus[] = ['PENDING', 'IN_PROGRESS', 'FINALIZING'];

/** Тестийн dms: дүрмүүд (нэг идэвхтэй хүсэлт, resend/cancel зөвхөн идэвхтэйд) жинхэнэтэй нийцнэ. */
export class FakeEsignGateway implements EsignGateway {
  readonly calls: { op: Op; ctx: RequestContext; input: CreateSigningRequest | string }[] = [];
  private readonly views = new Map<string, SigningRequestView>();
  private readonly failures = new Map<Op, Error>();
  private seq = 0;
  private links = 0;

  /** Дараагийн `op` дуудлагыг нэг удаа энэ алдаагаар унагаана */
  failNext(op: Op, error: Error): void {
    this.failures.set(op, error);
  }

  /** dms талд төлөв шилжсэнийг дуурайх (жишээ нь зээлдэгч татгалзсан) */
  setStatus(id: string, patch: Partial<SigningRequestView>): void {
    this.views.set(id, { ...this.must(id), ...patch });
  }

  async createRequest(input: CreateSigningRequest, ctx: RequestContext): Promise<IssuedSigningRequest> {
    this.record('createRequest', ctx, input);
    for (const v of this.views.values()) {
      if (v.contractId === input.contractId && ACTIVE.includes(v.status)) throw new ConflictException('active signing request exists');
    }
    const id = `sr-${++this.seq}`;
    const view: SigningRequestView = {
      id, orgId: ctx.orgId, applicationId: input.applicationId, contractId: input.contractId, contractNo: input.contractNo, status: 'PENDING', provider: null,
      signerCustomerId: input.signer.customerId, signerNameMasked: 'Б. Болд', signerPhoneMasked: `+976 ${maskPhone(input.signer.phone)}`,
      linkExpiresAt: new Date(Date.UTC(2026, 9, 31, 9, 0, 0)).toISOString(), signedAt: null, signedFileId: null, signatureFileId: null, verificationCode: null,
      failureReason: null, providerMock: false, createdAt: new Date(Date.UTC(2026, 9, 28, 9, 0, 0)).toISOString(),
    };
    this.views.set(id, view);
    return { ...view, signingUrl: this.url(id) };
  }

  async resend(signingRequestId: string, ctx: RequestContext): Promise<IssuedSigningRequest> {
    this.record('resend', ctx, signingRequestId);
    const view = this.must(signingRequestId);
    if (!ACTIVE.includes(view.status)) throw new ConflictException('request is not active');
    return { ...view, signingUrl: this.url(signingRequestId) };
  }

  async cancel(signingRequestId: string, ctx: RequestContext): Promise<SigningRequestView> {
    this.record('cancel', ctx, signingRequestId);
    const view = this.must(signingRequestId);
    if (!ACTIVE.includes(view.status)) throw new ConflictException('request is not active');
    const cancelled: SigningRequestView = { ...view, status: 'CANCELLED', failureReason: 'CANCELLED' };
    this.views.set(signingRequestId, cancelled);
    return cancelled;
  }

  async get(signingRequestId: string, ctx: RequestContext): Promise<SigningRequestView> {
    this.record('get', ctx, signingRequestId);
    return this.must(signingRequestId);
  }

  private record(op: Op, ctx: RequestContext, input: CreateSigningRequest | string): void {
    this.calls.push({ op, ctx, input });
    const failure = this.failures.get(op);
    if (failure) {
      this.failures.delete(op);
      throw failure;
    }
  }

  private must(id: string): SigningRequestView {
    const view = this.views.get(id);
    if (!view) throw new NotFoundException('signing request not found');
    return { ...view };
  }

  private url(id: string): string {
    return `https://sign.example.test/sign/token-${id}-${++this.links}`;
  }
}
