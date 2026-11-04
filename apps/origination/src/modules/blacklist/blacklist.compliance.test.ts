// Q-128…Q-136: Хар дээрх 4 нүд, Саарал 12 сарын хугацаа, заавал шалтгаан, эх сурвалж, handler, sweeper.
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminCtx, entryInput, FakeMakerChecker, FixedClock, fixedSettings, makeService, SequentialIds } from './test-support';
import { BlacklistCreateBody, BlacklistPatchBody } from './blacklist.schemas';
import { BlacklistService, AUTO_EXPIRED_REASON } from './blacklist.service';
import { InMemoryBlacklistRepository } from './in-memory-blacklist.repository';
import { BlacklistEscalationHandler, type EscalationTx } from './blacklist-escalation.handler';
import { BlacklistExpirySweeper, parseExpirySeconds } from './blacklist-expiry.sweeper';
import { ChangeConflictError, ChangeHandlerRegistry } from '../maker-checker/change-handler';

const DAY = 86_400_000;
const input = (over: Record<string, unknown> = {}) => BlacklistCreateBody.parse(entryInput(over));
const patch = (body: Record<string, unknown>) => BlacklistPatchBody.parse(body);

describe('blacklist compliance rules', () => {
  let repo: InMemoryBlacklistRepository;
  let clock: FixedClock;
  let mc: FakeMakerChecker;
  let service: BlacklistService;
  beforeEach(() => {
    repo = new InMemoryBlacklistRepository();
    clock = new FixedClock();
    mc = new FakeMakerChecker();
    service = makeService(repo, clock, new SequentialIds(), mc, fixedSettings(12));
  });

  it('Grey gets validUntil = now + grey_valid_months and no four-eyes request', async () => {
    const e = await service.create(adminCtx(), input({ severity: 'GREY' }));
    expect(e).toMatchObject({ isActive: true, severity: 'GREY', pendingSeverity: null });
    expect(new Date(e.validUntil!).getUTCFullYear()).toBe(2027);
    expect(mc.submitted).toHaveLength(0);
  });

  it('a new Black entry is held inactive and a PII-free change request is submitted', async () => {
    const e = await service.create(adminCtx(), input({ severity: 'BLACK', source: 'COURT' }));
    expect(e).toMatchObject({ isActive: false, pendingSeverity: 'BLACK', validUntil: null, source: 'COURT' });
    expect(mc.submitted).toHaveLength(1);
    const s = mc.submitted[0]!.input;
    expect(s).toMatchObject({ targetType: 'BLACKLIST_ENTRY', action: 'ACTIVATE_BLACK', targetId: e.id, payload: { entryId: e.id } });
    expect(JSON.stringify(s)).not.toContain('УБ');
  });

  it('Grey -> Black goes through four-eyes while the entry stays active Grey; Black -> Grey is direct', async () => {
    const grey = await service.create(adminCtx(), input({ severity: 'GREY' }));
    const up = await service.update(adminCtx(), grey.id, patch({ severity: 'BLACK' }));
    expect(up).toMatchObject({ isActive: true, severity: 'GREY', pendingSeverity: 'BLACK' });
    expect(mc.submitted).toHaveLength(1);
    const down = await service.update(adminCtx(), grey.id, patch({ severity: 'GREY' }));
    expect(down.pendingSeverity).toBeNull();
    expect(mc.submitted).toHaveLength(1);
  });

  it('deactivation needs a reason (400) and stores it', async () => {
    const e = await service.create(adminCtx(), input({ severity: 'GREY' }));
    await expect(service.update(adminCtx(), e.id, patch({ isActive: false }))).rejects.toBeInstanceOf(BadRequestException);
    const done = await service.deactivate(adminCtx(), e.id, 'Төлбөр барагдсан');
    expect(done).toMatchObject({ isActive: false, deactivationReason: 'Төлбөр барагдсан' });
  });

  it('expireDue deactivates only expired Grey entries with the AUTO_EXPIRED reason', async () => {
    const a = await service.create(adminCtx(), input({ severity: 'GREY' }));
    await service.create(adminCtx(), input({ registerNo: 'УБ99999999', severity: 'GREY', validUntil: new Date(clock.now().getTime() + 800 * DAY).toISOString() }));
    clock.advance(400 * DAY);
    expect(await service.expireDue()).toBe(1);
    expect(await repo.findById('org-1', a.id)).toMatchObject({ isActive: false, deactivationReason: AUTO_EXPIRED_REASON });
    expect(await service.expireDue()).toBe(0);
  });

  it('sweeper tick runs the service and parseExpirySeconds clamps', async () => {
    await service.create(adminCtx(), input({ severity: 'GREY' }));
    clock.advance(400 * DAY);
    expect(await new BlacklistExpirySweeper(service).tick()).toBe(1);
    expect([parseExpirySeconds(undefined), parseExpirySeconds('0'), parseExpirySeconds('x'), parseExpirySeconds('999999')]).toEqual([3600, 0, 3600, 86400]);
  });
});

describe('BlacklistEscalationHandler', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: '00000000-0000-4000-8000-000000000001', orgId: 'org-1', registerNoHash: 'a'.repeat(64), customerType: 'INDIVIDUAL', name: 'Бат', listType: 'DELINQUENT',
    severity: 'GREY', reasonCode: 'LATE_PAYMENT', isActive: false, pendingSeverity: 'BLACK', updatedAt: new Date('2026-10-28T09:00:00Z'), ...over,
  });
  const fakeTx = (r: ReturnType<typeof row> | null, count = 1) => {
    const calls = { update: [] as object[], outbox: [] as { payload: Record<string, unknown> }[], audit: [] as { afterJson: unknown }[] };
    const tx = {
      blacklist: { findFirst: async () => r, updateMany: async (a: { data: object }) => { calls.update.push(a.data); return { count }; } },
      outbox: { create: async ({ data }: { data: { payload: Record<string, unknown> } }) => { calls.outbox.push(data); } },
      auditLog: { create: async ({ data }: { data: { afterJson: unknown } }) => { calls.audit.push(data); } },
    } as unknown as EscalationTx;
    return { tx, calls };
  };
  const handler = () => new BlacklistEscalationHandler(new ChangeHandlerRegistry());
  const req = { id: 'cr-1', orgId: 'org-1', makerId: 'maker', correlationId: 'c' } as never;
  const ctx = (tx: EscalationTx) => ({ db: tx, request: req, payload: { entryId: row().id }, checker: { userId: 'checker' } }) as never;

  it('activates the entry as Black, emits the event and audit', async () => {
    const { tx, calls } = fakeTx(row());
    await handler().apply(ctx(tx));
    expect(calls.update[0]).toMatchObject({ severity: 'BLACK', isActive: true, pendingSeverity: null, validUntil: null });
    expect(JSON.stringify(calls.outbox)).toContain('BlacklistEntryChanged');
    expect(JSON.stringify(calls.outbox)).not.toContain('УБ');
    expect(calls.audit).toHaveLength(1);
  });
  it('conflicts when the entry is no longer pending or was modified concurrently', async () => {
    await expect(handler().apply(ctx(fakeTx(row({ pendingSeverity: null })).tx))).rejects.toBeInstanceOf(ChangeConflictError);
    await expect(handler().apply(ctx(fakeTx(row(), 0).tx))).rejects.toBeInstanceOf(ChangeConflictError);
  });
});
