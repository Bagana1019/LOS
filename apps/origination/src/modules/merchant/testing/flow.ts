import { expect } from 'vitest';
import type { PosLeaseAdminView, PosLeaseView } from '@los/contracts';
import type { Fixtures } from './fixtures';
import { buyerPhone, buyerRegister, leaseBody } from './fixtures';
import type { HeaderMap, Personas } from './personas';
import type { HttpResult, TestApp } from './test-app';

export const FIXED_OTP = '123456';

/** HTTP e2e тестийн урсгал туслах: мерчант A-ийн кассир/админ/лизингийн байгууллагын persona-ууд. */
export class PosFlow {
  private n = 0;
  private keyN = 0;
  readonly p: Personas;
  constructor(readonly t: TestApp, readonly fx: Fixtures) {
    this.p = t.personas(fx.merchantA.id);
  }
  staff1(): HeaderMap { return this.p.staff(this.fx.storeA1.id); }
  staff2(): HeaderMap { return this.p.staff(this.fx.storeA2.id, 'staff-2'); }
  admin(): HeaderMap { return this.p.merchantAdmin(); }
  lender(): HeaderMap { return this.p.lenderAdmin(); }
  approver(): HeaderMap { return this.p.approver(); }
  /** Мерчант B-ийн админ */
  adminB(): HeaderMap { return this.t.personas(this.fx.merchantB.id).merchantAdmin('merchant-admin-b'); }

  nextSeed(): number { return this.n++; }

  /** POST /merchant-portal/leases */
  create(opts: { digit?: number; headers?: HeaderMap; over?: Partial<Record<string, unknown>>; seed?: number; key?: string; storeId?: string | null } = {}): Promise<HttpResult> {
    const seed = opts.seed ?? this.nextSeed();
    const storeId = opts.storeId === null ? undefined : (opts.storeId ?? this.fx.storeA1.id);
    return this.t.postJson('/merchant-portal/leases', opts.headers ?? this.staff1(), leaseBody(storeId, opts.digit ?? 0, opts.over ?? {}, seed), { 'idempotency-key': opts.key ?? `idem-key-${seed}-${++this.keyN}` });
  }
  async createOk(opts: Parameters<PosFlow['create']>[0] = {}): Promise<PosLeaseView> {
    const res = await this.create(opts);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.lease;
  }
  /** otp = null → кодгүй (дахин оролдлого) */
  submit(id: string, otp: string | null = FIXED_OTP, headers: HeaderMap = this.staff1()) {
    return this.t.postJson(`/merchant-portal/leases/${id}/submit`, headers, otp === null ? {} : { otp });
  }
  acceptOtp(id: string, headers: HeaderMap = this.staff1()) { return this.t.postJson(`/merchant-portal/leases/${id}/otp/accept`, headers); }
  accept(id: string, otp: string = FIXED_OTP, headers: HeaderMap = this.staff1()) { return this.t.postJson(`/merchant-portal/leases/${id}/accept`, headers, { otp }); }
  deliver(id: string, body: object = {}, headers: HeaderMap = this.staff1()) { return this.t.postJson(`/merchant-portal/leases/${id}/deliver`, headers, body); }
  cancel(id: string, reason = 'Худалдан авагч татгалзав', headers: HeaderMap = this.staff1()) { return this.t.postJson(`/merchant-portal/leases/${id}/cancel`, headers, { reason }); }
  get(id: string, headers: HeaderMap = this.staff1()) { return this.t.getJson(`/merchant-portal/leases/${id}`, headers); }

  async ok<T = PosLeaseView>(res: HttpResult, status = 200): Promise<T> {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as T;
  }

  /** create + submit */
  async toDecided(opts: Parameters<PosFlow['create']>[0] = {}): Promise<PosLeaseView> {
    const lease = await this.createOk(opts);
    return this.ok(await this.submit(lease.id, FIXED_OTP, opts.headers ?? this.staff1()));
  }
  /** create + submit + accept (digit 0 → APPROVE) */
  async toAccepted(opts: Parameters<PosFlow['create']>[0] = {}): Promise<PosLeaseView> {
    const headers = opts.headers ?? this.staff1();
    const approved = await this.toDecided(opts);
    expect(approved.status).toBe('APPROVED');
    this.t.clock.advanceSeconds(31);
    await this.ok(await this.acceptOtp(approved.id, headers));
    return this.ok(await this.accept(approved.id, FIXED_OTP, headers));
  }
  async toDelivered(opts: Parameters<PosFlow['create']>[0] = {}): Promise<PosLeaseView> {
    const accepted = await this.toAccepted(opts);
    return this.ok(await this.deliver(accepted.id, {}, opts.headers ?? this.staff1()));
  }
  adminGet(id: string, headers: HeaderMap = this.lender()) { return this.t.getJson(`/pos-leases/${id}`, headers); }
  async adminView(id: string, headers: HeaderMap = this.lender()): Promise<PosLeaseAdminView> {
    return this.ok<PosLeaseAdminView>(await this.adminGet(id, headers));
  }
  review(id: string, decision: 'APPROVE' | 'DECLINE', comment = 'Баримтыг хянаж үзлээ', headers: HeaderMap = this.approver()) {
    return this.t.postJson(`/pos-leases/${id}/review`, headers, { decision, comment });
  }
  settle(id: string, settlementRef = 'PAY-2026-0001', headers: HeaderMap = this.lender()) {
    return this.t.postJson(`/pos-leases/${id}/settle`, headers, { settlementRef });
  }
  /** Нэг лизингтэй холбоотой outbox-ийн event type-ууд (дараалалтай) */
  eventTypes(leaseId?: string): string[] {
    return this.t.outbox.events.filter((e) => e.type.startsWith('PosLease') && (!leaseId || (e as { leaseId?: string }).leaseId === leaseId)).map((e) => e.type);
  }
}

export { buyerPhone, buyerRegister };
