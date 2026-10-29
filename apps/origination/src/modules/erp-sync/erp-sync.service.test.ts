import { afterEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { ErpDisbursementInput, ErpFeeDeductionInput, ErpRepaymentInput } from '@los/contracts';
import { IdempotencyConflictError, InvalidErpEventInputError } from './erp-sync.errors';
import { ErpSyncService, type EmitResult } from './erp-sync.service';
import { Clock } from '@los/nest-common';
import { buildErpPayload } from './erp-payload';
import { ERP_EVENT_REPOSITORY, type ErpEventDetail } from './erp-event.repository';
import { MemoryErpEventRepository } from './testing/memory-erp-event.repository';

const STANDALONE = { standalone: true } as const;

const NOW = new Date('2026-10-28T09:00:00.000Z');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const base = {
  orgId: 'org-1', branchId: 'br-1', applicationId: 'app-1', contractNo: 'C-2026-0001', coreLoanId: 'L-1', customerId: 'cu-1', currency: 'MNT', businessDate: '2026-10-28',
};
// The inputs are validated at runtime (zod), so the builders are deliberately loose: tests also pass invalid values through `over`
const disbursement = (over: Record<string, unknown> = {}) => ({ ...base, sourceId: 'dr-1', amount: '10000000.00', ...over }) as ErpDisbursementInput;
const fees = (over: Record<string, unknown> = {}) => ({ ...base, sourceId: 'fee-1', fees: [{ kind: 'ORIGINATION', amount: 100_000 }], ...over }) as ErpFeeDeductionInput;
const repayment = (over: Record<string, unknown> = {}) => ({ ...base, sourceId: 'pay-1', receivedAmount: '1000000.00', principal: '700000.00', interest: '300000.00', penalty: '0', fee: '0', overpayment: '0', ...over }) as ErpRepaymentInput;

interface SetupOpts { clock?: Clock | null }

function setup(o: SetupOpts = {}) {
  const repo = new MemoryErpEventRepository();
  const clock: Clock | null = o.clock === undefined ? { now: () => NOW } : o.clock;
  const service = new ErpSyncService(repo, clock ?? undefined);
  const event = async (r: EmitResult): Promise<ErpEventDetail> => {
    const e = await repo.getById(r.eventId);
    if (!e) throw new Error(`event ${r.eventId} missing`);
    return e;
  };
  const rows = async () => (await repo.list({ limit: 100 })).items;
  return { repo, service, event, rows };
}

async function rejectionOf(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); } catch (e) { return e; }
  throw new Error('expected the call to reject');
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('ErpSyncService.emitDisbursement', () => {
  it('stores the business event with the amount and nothing ledger-specific', async () => {
    const { service, event } = setup();
    const res = await service.emitDisbursement(disbursement(), STANDALONE);

    expect(res).toEqual({ eventId: expect.stringMatching(UUID), idempotencyKey: 'DISBURSEMENT:dr-1', status: 'PENDING', created: true });
    const e = await event(res);
    expect(e).toMatchObject({ eventType: 'DISBURSEMENT', amount: '10000000.00', data: { amount: '10000000.00' } });
    expect(e).not.toHaveProperty('lines');
    expect(e.data).not.toHaveProperty('accountCode');
  });

  it('stores the header, a PENDING status and the clock time on the outbox row', async () => {
    const { service, event } = setup();
    const e = await event(await service.emitDisbursement(disbursement({ actorId: 'u-1' }), STANDALONE));
    expect(e).toMatchObject({
      orgId: 'org-1', branchId: 'br-1', applicationId: 'app-1', contractNo: 'C-2026-0001', coreLoanId: 'L-1', customerId: 'cu-1',
      currency: 'MNT', businessDate: '2026-10-28', sourceId: 'dr-1', status: 'PENDING', attempts: 0, createdAt: NOW, nextAttemptAt: NOW,
    });
  });

  it('generates a correlation id when the caller gives none, and keeps them distinct per event', async () => {
    const { service, event } = setup();
    const a = await event(await service.emitDisbursement(disbursement({ sourceId: 'a' }), STANDALONE));
    const b = await event(await service.emitDisbursement(disbursement({ sourceId: 'b' }), STANDALONE));
    const c = await event(await service.emitDisbursement(disbursement({ sourceId: 'c', correlationId: 'corr-given' }), STANDALONE));
    expect(a.correlationId).toMatch(UUID);
    expect(a.correlationId).not.toBe(b.correlationId);
    expect(c.correlationId).toBe('corr-given');
  });

  it('defaults the optional header fields to null', async () => {
    const { service, event } = setup();
    const { branchId: _b, contractNo: _c, coreLoanId: _l, customerId: _u, ...minimal } = base;
    const e = await event(await service.emitDisbursement({ ...minimal, sourceId: 'dr-9', amount: '5.00' } as ErpDisbursementInput, STANDALONE));
    expect(e).toMatchObject({ branchId: null, contractNo: null, coreLoanId: null, customerId: null });
  });

  it('accepts amounts as numbers and strings and normalises them to two decimals', async () => {
    const { service, event } = setup();
    for (const [i, [amount, expected]] of ([[1500, '1500.00'], [1500.5, '1500.50'], ['1500', '1500.00'], ['1500.5', '1500.50'], [' 7 ', '7.00']] as const).entries()) {
      const e = await event(await service.emitDisbursement(disbursement({ sourceId: `n-${i}`, amount }), STANDALONE));
      expect([e.amount, e.data]).toEqual([expected, { amount: expected }]);
    }
  });

  it('assigns increasing seq numbers in call order', async () => {
    const { service, event } = setup();
    const a = await event(await service.emitDisbursement(disbursement({ sourceId: 'a' }), STANDALONE));
    const b = await event(await service.emitFeeDeduction(fees({ sourceId: 'b' }), STANDALONE));
    const c = await event(await service.emitRepayment(repayment({ sourceId: 'c' }), STANDALONE));
    expect(a.seq < b.seq && b.seq < c.seq).toBe(true);
  });
});

describe('ErpSyncService.emitFeeDeduction', () => {
  it('passes every fee with its kind and the total, keeping the order', async () => {
    const { service, event } = setup();
    const res = await service.emitFeeDeduction(fees({
      fees: [{ kind: 'ORIGINATION', amount: 100_000, memo: 'Зээл олгох' }, { kind: 'INSURANCE', amount: '25000.50' }, { kind: 'SERVICE', amount: '0.01' }],
    }), STANDALONE);
    const e = await event(res);
    expect(e).toMatchObject({ eventType: 'FEE_DEDUCTION', amount: '125000.51' });
    expect(e.data).toEqual({
      fees: [{ kind: 'ORIGINATION', amount: '100000.00', memo: 'Зээл олгох' }, { kind: 'INSURANCE', amount: '25000.50' }, { kind: 'SERVICE', amount: '0.01' }],
      totalAmount: '125000.51',
    });
  });

  it('keeps one entry per fee when two fees share a kind', async () => {
    const { service, event } = setup();
    const e = await event(await service.emitFeeDeduction(fees({ fees: [{ kind: 'OTHER', amount: 10 }, { kind: 'OTHER', amount: 20 }] }), STANDALONE));
    expect((e.data as { fees: unknown[] }).fees).toHaveLength(2);
    expect(e.amount).toBe('30.00');
  });
});

describe('ErpSyncService.emitRepayment', () => {
  it('passes the received amount with its explicit allocation', async () => {
    const { service, event } = setup();
    const e = await event(await service.emitRepayment(repayment({ penalty: 5000, fee: 2500, receivedAmount: '1007500', overpayment: 0 }), STANDALONE));
    expect(e).toMatchObject({ eventType: 'REPAYMENT', amount: '1007500.00' });
    expect(e.data).toEqual({ receivedAmount: '1007500.00', principal: '700000.00', interest: '300000.00', penalty: '5000.00', fee: '2500.00', overpayment: '0.00' });
  });

  it('passes a declared overpayment through, including an overpayment-only receipt', async () => {
    const { service, event } = setup();
    const some = await event(await service.emitRepayment(repayment({ sourceId: 'p-1', receivedAmount: '1000300', overpayment: '300' }), STANDALONE));
    expect((some.data as { overpayment: string }).overpayment).toBe('300.00');
    const only = await event(await service.emitRepayment(repayment({ sourceId: 'p-2', receivedAmount: '50', principal: 0, interest: 0, overpayment: 50 }), STANDALONE));
    expect(only.data).toEqual({ receivedAmount: '50.00', principal: '0.00', interest: '0.00', penalty: '0.00', fee: '0.00', overpayment: '50.00' });
  });

  it.each([
    ['less than received', { principal: '699999.99' }],
    ['more than received', { interest: '300000.01' }],
    ['all zero while money was received', { principal: 0, interest: 0 }],
  ])('rejects an allocation that is %s, so a forgotten component never becomes "overpayment"', async (_name, over) => {
    const { service, rows } = setup();
    const e = await rejectionOf(() => service.emitRepayment(repayment(over), STANDALONE));
    expect(e).toBeInstanceOf(InvalidErpEventInputError);
    expect((e as Error).message).toContain('does not equal receivedAmount');
    expect(await rows()).toHaveLength(0);
  });

  it('produces an event whose payload is deliverable for every event type', async () => {
    const { service, event } = setup();
    for (const r of [
      await service.emitDisbursement(disbursement(), STANDALONE),
      await service.emitFeeDeduction(fees(), STANDALONE),
      await service.emitRepayment(repayment(), STANDALONE),
    ]) {
      const stored = await event(r);
      expect(() => buildErpPayload(stored)).not.toThrow();
    }
  });
});

describe('ErpSyncService idempotency', () => {
  it('is a no-op for the same business event and returns the original event', async () => {
    const { service, rows } = setup();
    const first = await service.emitDisbursement(disbursement(), STANDALONE);
    const again = await service.emitDisbursement(disbursement(), STANDALONE);
    expect(first.created).toBe(true);
    expect(again).toEqual({ ...first, created: false });
    expect(await rows()).toHaveLength(1);
  });

  it('treats equal amounts written in different forms as the same event', async () => {
    const { service, rows } = setup();
    const a = await service.emitDisbursement(disbursement({ amount: 10 }), STANDALONE);
    const b = await service.emitDisbursement(disbursement({ amount: '10.00' }), STANDALONE);
    expect(b).toEqual({ ...a, created: false });
    expect(await rows()).toHaveLength(1);
  });

  it('ignores memo, correlation id and actor on a replay', async () => {
    const { service, event } = setup();
    const a = await service.emitFeeDeduction(fees({ correlationId: 'c-1', actorId: 'u-1', fees: [{ kind: 'SERVICE', amount: 5, memo: 'one' }] }), STANDALONE);
    const b = await service.emitFeeDeduction(fees({ correlationId: 'c-2', actorId: 'u-2', fees: [{ kind: 'SERVICE', amount: 5, memo: 'two' }] }), STANDALONE);
    expect(b.created).toBe(false);
    expect((await event(a)).correlationId).toBe('c-1');
  });

  it('reports the current delivery status of the existing event on a replay', async () => {
    const { service, repo } = setup();
    const first = await service.emitDisbursement(disbursement(), STANDALONE);
    const claimed = await repo.claimNext({ now: NOW, leaseMs: 60_000, workerId: 'w1' });
    await repo.complete({
      id: first.eventId, workerId: 'w1', attemptNo: claimed!.attempts, completion: { outcome: 'SENT', externalRef: 'ERP-1', duplicate: false },
      target: 'mock', startedAt: NOW, finishedAt: NOW,
    });
    expect(await service.emitDisbursement(disbursement(), STANDALONE)).toEqual({ ...first, status: 'SENT', created: false });
  });

  it('keys by event type: the same source id on different event types creates separate events', async () => {
    const { service, rows } = setup();
    await service.emitDisbursement(disbursement({ sourceId: 'x-1' }), STANDALONE);
    await service.emitFeeDeduction(fees({ sourceId: 'x-1' }), STANDALONE);
    await service.emitRepayment(repayment({ sourceId: 'x-1' }), STANDALONE);
    expect((await rows()).map((r) => r.idempotencyKey).sort()).toEqual(['DISBURSEMENT:x-1', 'FEE_DEDUCTION:x-1', 'REPAYMENT:x-1']);
  });

  it('keys by organisation: the same source id in two organisations creates separate events', async () => {
    const { service, rows } = setup();
    const a = await service.emitDisbursement(disbursement({ orgId: 'org-1' }), STANDALONE);
    const b = await service.emitDisbursement(disbursement({ orgId: 'org-2' }), STANDALONE);
    expect([a.created, b.created]).toEqual([true, true]);
    expect(await rows()).toHaveLength(2);
  });

  it('throws IdempotencyConflictError for the same source id with a different amount and leaves the original untouched', async () => {
    const { service, event, rows } = setup();
    const first = await service.emitDisbursement(disbursement(), STANDALONE);
    const e = await rejectionOf(() => service.emitDisbursement(disbursement({ amount: '10000000.01' }), STANDALONE));
    expect(e).toBeInstanceOf(IdempotencyConflictError);
    expect((e as IdempotencyConflictError).idempotencyKey).toBe('DISBURSEMENT:dr-1');
    expect((await event(first)).amount).toBe('10000000.00');
    expect(await rows()).toHaveLength(1);
  });

  it('throws IdempotencyConflictError when the allocation changes but the received total stays the same', async () => {
    const { service } = setup();
    await service.emitRepayment(repayment(), STANDALONE);
    const e = await rejectionOf(() => service.emitRepayment(repayment({ principal: '600000.00', interest: '400000.00' }), STANDALONE));
    expect(e).toBeInstanceOf(IdempotencyConflictError);
  });

  it('throws IdempotencyConflictError when a fee kind changes', async () => {
    const { service } = setup();
    await service.emitFeeDeduction(fees({ fees: [{ kind: 'SERVICE', amount: 5 }] }), STANDALONE);
    const e = await rejectionOf(() => service.emitFeeDeduction(fees({ fees: [{ kind: 'INSURANCE', amount: 5 }] }), STANDALONE));
    expect(e).toBeInstanceOf(IdempotencyConflictError);
  });

  it('treats a replay on another business date as the same event and keeps the original date', async () => {
    const { service, event } = setup();
    const first = await service.emitDisbursement(disbursement(), STANDALONE);
    const again = await service.emitDisbursement(disbursement({ businessDate: '2026-11-03' }), STANDALONE);
    expect(again.created).toBe(false);
    expect((await event(first)).businessDate).toBe('2026-10-28');
  });

  it('keeps one event when the same event is emitted concurrently', async () => {
    const { service, rows } = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => service.emitDisbursement(disbursement(), STANDALONE)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });
});

describe('ErpSyncService transaction pass-through', () => {
  it.each([
    ['no options', undefined],
    ['an empty options object', {}],
    ['a missing transaction', { tx: undefined }],
    ['standalone: false', { standalone: false }],
  ])('rejects %s instead of writing outside the business transaction', async (_name, opts) => {
    const { service, rows } = setup();
    const e = await rejectionOf(() => service.emitDisbursement(disbursement(), opts as never));
    expect(e).toBeInstanceOf(InvalidErpEventInputError);
    expect((e as Error).message).toMatch(/tx|standalone/);
    expect(await rows()).toHaveLength(0);
  });

  const calls: Array<[string, (s: ErpSyncService, tx?: unknown) => Promise<EmitResult>]> = [
    ['emitDisbursement', (s, tx) => s.emitDisbursement(disbursement(), tx ? { tx } : STANDALONE)],
    ['emitFeeDeduction', (s, tx) => s.emitFeeDeduction(fees(), tx ? { tx } : STANDALONE)],
    ['emitRepayment', (s, tx) => s.emitRepayment(repayment(), tx ? { tx } : STANDALONE)],
  ];

  it.each(calls)('%s hands the caller transaction to the repository', async (_name, call) => {
    const { service, repo } = setup();
    const insert = vi.spyOn(repo, 'insert');
    const tx = { marker: 'caller-tx' };

    await call(service, tx);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]![1]).toBe(tx);
  });

  it.each(calls)('%s passes no transaction when none is given', async (_name, call) => {
    const { service, repo } = setup();
    const insert = vi.spyOn(repo, 'insert');
    await call(service);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]![1]).toBeUndefined();
  });

  it('passes the complete draft to the repository', async () => {
    const { service, repo } = setup();
    const insert = vi.spyOn(repo, 'insert');
    await service.emitDisbursement(disbursement({ correlationId: 'corr-1', actorId: 'u-1' }), STANDALONE);
    const draft = insert.mock.calls[0]![0];
    expect(draft).toMatchObject({
      idempotencyKey: 'DISBURSEMENT:dr-1', eventType: 'DISBURSEMENT', sourceId: 'dr-1', correlationId: 'corr-1', amount: '10000000.00',
      data: { amount: '10000000.00' }, now: NOW, header: { orgId: 'org-1', applicationId: 'app-1', businessDate: '2026-10-28', actorId: 'u-1' },
    });
    expect(draft.id).toMatch(UUID);
    expect(draft.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not touch the repository when the input is invalid', async () => {
    const { service, repo } = setup();
    const insert = vi.spyOn(repo, 'insert');
    await rejectionOf(() => service.emitDisbursement(disbursement({ amount: 0 }), STANDALONE));
    expect(insert).not.toHaveBeenCalled();
  });

  it('propagates repository failures unchanged', async () => {
    const { service, repo } = setup();
    const boom = new Error('db down');
    vi.spyOn(repo, 'insert').mockRejectedValueOnce(boom);
    expect(await rejectionOf(() => service.emitDisbursement(disbursement(), STANDALONE))).toBe(boom);
  });
});

describe('ErpSyncService input validation', () => {
  type Call = (s: ErpSyncService) => Promise<EmitResult>;
  const cases: Array<[string, Call, string]> = [
    ['disbursement without orgId', (s) => s.emitDisbursement(disbursement({ orgId: undefined }), STANDALONE), 'orgId'],
    ['disbursement with empty applicationId', (s) => s.emitDisbursement(disbursement({ applicationId: '' }), STANDALONE), 'applicationId'],
    ['disbursement with empty sourceId', (s) => s.emitDisbursement(disbursement({ sourceId: '' }), STANDALONE), 'sourceId'],
    ['disbursement with a 121 character sourceId', (s) => s.emitDisbursement(disbursement({ sourceId: 's'.repeat(121) }), STANDALONE), 'sourceId'],
    ['disbursement with a malformed business date', (s) => s.emitDisbursement(disbursement({ businessDate: '2026/10/28' }), STANDALONE), 'businessDate'],
    ['disbursement with an impossible calendar date', (s) => s.emitDisbursement(disbursement({ businessDate: '2026-02-30' }), STANDALONE), 'businessDate'],
    ['disbursement with month 13', (s) => s.emitDisbursement(disbursement({ businessDate: '2026-13-01' }), STANDALONE), 'businessDate'],
    ['disbursement with a lower-case currency', (s) => s.emitDisbursement(disbursement({ currency: 'mnt' }), STANDALONE), 'currency'],
    ['disbursement of zero', (s) => s.emitDisbursement(disbursement({ amount: 0 }), STANDALONE), 'amount'],
    ['disbursement of a non-numeric amount', (s) => s.emitDisbursement(disbursement({ amount: 'abc' }), STANDALONE), 'amount'],
    ['disbursement with three decimals', (s) => s.emitDisbursement(disbursement({ amount: '10.005' }), STANDALONE), 'amount'],
    ['disbursement without amount', (s) => s.emitDisbursement(disbursement({ amount: undefined }), STANDALONE), 'amount'],
    ['fee deduction without fees', (s) => s.emitFeeDeduction(fees({ fees: [] }), STANDALONE), 'fees'],
    ['fee deduction with an unknown fee kind', (s) => s.emitFeeDeduction(fees({ fees: [{ kind: 'BRIBE', amount: 5 }] }), STANDALONE), 'fees.0.kind'],
    ['fee deduction with a zero fee', (s) => s.emitFeeDeduction(fees({ fees: [{ kind: 'SERVICE', amount: 0 }] }), STANDALONE), 'fees.0.amount'],
    ['fee deduction with more than 20 fees', (s) => s.emitFeeDeduction(fees({ fees: Array.from({ length: 21 }, () => ({ kind: 'OTHER', amount: 1 })) }), STANDALONE), 'fees'],
    ['repayment of zero', (s) => s.emitRepayment(repayment({ receivedAmount: 0, principal: 0, interest: 0, penalty: 0, fee: 0, overpayment: 0 }), STANDALONE), 'receivedAmount'],
    ['repayment with a malformed principal', (s) => s.emitRepayment(repayment({ principal: 'many' }), STANDALONE), 'principal'],
  ];

  it.each(cases)('rejects %s with InvalidErpEventInputError naming the field', async (_name, call, field) => {
    const { service, rows } = setup();
    const e = await rejectionOf(() => call(service));
    expect(e).toBeInstanceOf(InvalidErpEventInputError);
    expect((e as InvalidErpEventInputError).issues.some((i) => i.startsWith(`${field}:`))).toBe(true);
    expect(await rows()).toHaveLength(0);
  });

  it.each([
    ['disbursement', (s: ErpSyncService) => s.emitDisbursement(disbursement({ amount: -5 }), STANDALONE)],
    ['fee deduction', (s: ErpSyncService) => s.emitFeeDeduction(fees({ fees: [{ kind: 'SERVICE', amount: -5 }] }), STANDALONE)],
    ['repayment received', (s: ErpSyncService) => s.emitRepayment(repayment({ receivedAmount: '-5' }), STANDALONE)],
    ['repayment allocation', (s: ErpSyncService) => s.emitRepayment(repayment({ interest: -1 }), STANDALONE)],
  ])('rejects a negative %s amount with InvalidErpEventInputError (not a raw Error)', async (_name, call) => {
    const { service, rows } = setup();
    const e = await rejectionOf(() => call(service));
    expect(e).toBeInstanceOf(InvalidErpEventInputError);
    expect(await rows()).toHaveLength(0);
  });

  it('rejects fee totals beyond the 16 digit money limit instead of storing an undeliverable event', async () => {
    const { service, rows } = setup();
    const big = '9999999999999999.99';
    const e = await rejectionOf(() => service.emitFeeDeduction(fees({ fees: [{ kind: 'SERVICE', amount: big }, { kind: 'OTHER', amount: '0.01' }] }), STANDALONE));
    expect(e).toBeInstanceOf(InvalidErpEventInputError);
    expect(await rows()).toHaveLength(0);
  });

  it('reports every problem at once', async () => {
    const { service } = setup();
    const e = await rejectionOf(() => service.emitDisbursement(disbursement({ orgId: undefined, amount: 'abc', currency: 'x' }), STANDALONE));
    const fields = (e as InvalidErpEventInputError).issues.map((i) => i.split(':')[0]);
    expect(fields).toEqual(expect.arrayContaining(['orgId', 'amount', 'currency']));
  });

  it('rejects non-object input', async () => {
    const { service } = setup();
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(await rejectionOf(() => service.emitDisbursement(bad as never, STANDALONE)), String(bad)).toBeInstanceOf(InvalidErpEventInputError);
    }
  });

  it('delivers invalid input as a rejected promise, never as a synchronous throw', async () => {
    const { service } = setup();
    let returned: unknown;
    let thrownSync: unknown;
    try { returned = service.emitDisbursement(disbursement({ amount: 0 }), STANDALONE); } catch (e) { thrownSync = e; }

    expect(thrownSync).toBeUndefined();
    expect(returned).toBeInstanceOf(Promise);
    await expect(returned).rejects.toBeInstanceOf(InvalidErpEventInputError);
  });
});

describe('ErpSyncService clock and dependency injection', () => {
  it('stamps events with the injected clock', async () => {
    let t = NOW.getTime();
    const { service, event } = setup({ clock: { now: () => new Date(t) } });
    const a = await event(await service.emitDisbursement(disbursement({ sourceId: 'a' }), STANDALONE));
    t += 5_000;
    const b = await event(await service.emitDisbursement(disbursement({ sourceId: 'b' }), STANDALONE));
    expect(a.createdAt).toEqual(NOW);
    expect(a.nextAttemptAt).toEqual(NOW);
    expect(b.createdAt).toEqual(new Date(NOW.getTime() + 5_000));
  });

  it('falls back to the system clock when none is injected', async () => {
    const { service, event } = setup({ clock: null });
    const before = Date.now();
    const e = await event(await service.emitDisbursement(disbursement(), STANDALONE));
    expect(e.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(e.createdAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('resolves through Nest with the explicit tokens, with and without the optional clock', async () => {
    const repo = new MemoryErpEventRepository();
    const providers = [ErpSyncService, { provide: ERP_EVENT_REPOSITORY, useValue: repo }];

    const withClock = await Test.createTestingModule({ providers: [...providers, { provide: Clock, useValue: { now: () => NOW } }] }).compile();
    const a = await withClock.get(ErpSyncService).emitDisbursement(disbursement({ sourceId: 'di-1' }), STANDALONE);
    expect((await repo.getById(a.eventId))?.createdAt).toEqual(NOW);

    const withoutClock = await Test.createTestingModule({ providers }).compile();
    const before = Date.now();
    const b = await withoutClock.get(ErpSyncService).emitDisbursement(disbursement({ sourceId: 'di-2' }), STANDALONE);
    expect((await repo.getById(b.eventId))?.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});
