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
    const calls = { update: [] as object[], where: [] as object[], outbox: [] as { payload: Record<string, unknown> }[], audit: [] as { afterJson: unknown }[] };
    const tx = {
      blacklist: { findFirst: async () => r, updateMany: async (a: { data: object; where: object }) => { calls.update.push(a.data); calls.where.push(a.where); return { count }; } },
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
    expect(calls.audit[0]).toMatchObject({ entity: 'blacklist', action: 'ESCALATE_APPLIED', actorId: 'checker', afterJson: { severity: 'BLACK', isActive: true } });
  });
  it('conflicts when the entry is no longer pending or was modified concurrently', async () => {
    await expect(handler().apply(ctx(fakeTx(row({ pendingSeverity: null })).tx))).rejects.toBeInstanceOf(ChangeConflictError);
    await expect(handler().apply(ctx(fakeTx(row(), 0).tx))).rejects.toBeInstanceOf(ChangeConflictError);
  });

  // F8-2: Хар болгох хүсэлт татгалзагдсан/цуцлагдсан/хугацаа дууссан/FAILED бол мөр `pendingSeverity = BLACK`-ээр үлдэж, шинэ хүсэлт үүсэхгүй байсан.
  describe('onNotApplied (F8-2)', () => {
    type Outcome = 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
    const closed = (tx: EscalationTx, outcome: Outcome, actor: { userId: string } | null = { userId: 'checker' }) =>
      ({ db: tx, request: { ...(req as object), targetId: row().id, status: outcome }, outcome, actor }) as never;

    it.each([
      ['REJECTED', { userId: 'checker' }, 'checker'],
      ['CANCELLED', { userId: 'maker' }, 'maker'],
      ['EXPIRED', null, 'system'],
      ['FAILED', { userId: 'checker' }, 'checker'],
    ] as const)('%s clears pendingSeverity only, with a compare-and-set, an audit row and no event', async (outcome, actor, actorId) => {
      const { tx, calls } = fakeTx(row());
      await handler().onNotApplied(closed(tx, outcome, actor));

      expect(calls.update).toHaveLength(1);
      expect(calls.update[0]).toMatchObject({ pendingSeverity: null, updatedBy: actorId });
      expect(calls.update[0]).not.toHaveProperty('severity');
      expect(calls.update[0]).not.toHaveProperty('isActive');
      expect((calls.update[0] as { updatedAt: Date }).updatedAt.getTime()).toBeGreaterThan(row().updatedAt.getTime()); // CAS-ийг уншсан бусад writer-т харагдана
      expect(calls.where[0]).toMatchObject({ id: row().id, orgId: 'org-1', pendingSeverity: 'BLACK', updatedAt: row().updatedAt });
      expect(calls.outbox).toHaveLength(0); // severity/isActive өөрчлөгдөөгүй тул kyc projection-д event хэрэггүй
      expect(calls.audit).toEqual([expect.objectContaining({
        entity: 'blacklist', entityId: row().id, action: `ESCALATE_${outcome}`, actorId,
        beforeJson: expect.objectContaining({ pendingSeverity: 'BLACK' }), afterJson: expect.objectContaining({ pendingSeverity: null, changeRequestId: 'cr-1' }),
      })]);
    });

    it('does nothing when the entry is no longer pending Black (made Grey, deactivated or already cleared) or is gone', async () => {
      for (const r of [row({ pendingSeverity: null }), row({ pendingSeverity: 'GREY' }), null]) {
        const { tx, calls } = fakeTx(r as ReturnType<typeof row> | null);
        await handler().onNotApplied(closed(tx, 'REJECTED'));
        expect(calls.update).toHaveLength(0);
        expect(calls.audit).toHaveLength(0);
      }
    });

    /** `findFirst` бүр дараагийн мөрийг, `updateMany` бүр дараагийн тоог буцаана (зэрэг засварыг дуурайна). */
    const racing = (reads: ReturnType<typeof row>[], counts: number[]) => {
      const seen = { where: [] as { updatedAt: Date }[], audit: 0 };
      let reading = 0;
      let writing = 0;
      const tx = {
        blacklist: {
          findFirst: async () => reads[Math.min(reading++, reads.length - 1)],
          updateMany: async (a: { where: { updatedAt: Date } }) => { seen.where.push(a.where); return { count: counts[writing++] ?? 0 }; },
        },
        outbox: { create: async () => undefined },
        auditLog: { create: async () => { seen.audit++; } },
      } as unknown as EscalationTx;
      return { tx, seen };
    };

    it('re-reads and retries when the entry was modified between the read and the write', async () => {
      const later = new Date('2026-10-28T09:00:05Z');
      const { tx, seen } = racing([row(), row({ updatedAt: later })], [0, 1]);
      await handler().onNotApplied(closed(tx, 'REJECTED'));

      expect(seen.where.map((w) => w.updatedAt)).toEqual([row().updatedAt, later]);
      expect(seen.audit).toBe(1);
    });

    it('fails loudly (rolling the close back) instead of leaving the entry pending when it keeps changing', async () => {
      const { tx, seen } = racing([row()], [0, 0, 0, 0, 0]);
      await expect(handler().onNotApplied(closed(tx, 'REJECTED'))).rejects.toThrow(/modified concurrently/);
      expect(seen.audit).toBe(0);
    });

    it('lets a new Black request be created again once the stale pending marker is cleared (service level)', async () => {
      const repo = new InMemoryBlacklistRepository();
      const mc = new FakeMakerChecker();
      const service = makeService(repo, new FixedClock(), new SequentialIds(), mc, fixedSettings(12));
      const e = await service.create(adminCtx(), input({ severity: 'BLACK' }));
      expect(mc.submitted).toHaveLength(1);
      // pending маркер үлдсэн үед (өмнөх алдаа) дахин оролдлого хүсэлт үүсгэдэггүй: мөр өөрчлөгдөөгүй
      await service.create(adminCtx(), input({ severity: 'BLACK' }));
      expect(mc.submitted).toHaveLength(1);

      // handler pendingSeverity-г цэвэрлэсний дараа (мөрийг шууд хадгалж дууриана) дахин илгээж болно
      const stored = (await repo.findById('org-1', e.id))!;
      await repo.saveWithEvent({ ...stored, pendingSeverity: null, updatedAt: new Date(stored.updatedAt.getTime() + 1) }, repo.events[0]!, stored.updatedAt);
      const again = await service.create(adminCtx(), input({ severity: 'BLACK' }));
      expect(again).toMatchObject({ id: e.id, pendingSeverity: 'BLACK' });
      expect(mc.submitted).toHaveLength(2);
    });
  });
});
