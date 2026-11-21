// F8-2 (DB): "Хар" болгох 4 нүдний хүсэлт татгалзагдсан / цуцлагдсан / хугацаа дууссан үед мөр `pendingSeverity = BLACK`-ээр үлдэхгүй, шинэ хүсэлт үүснэ.
// Бодит PostgreSQL дээр бодит MakerCheckerService + PrismaChangeRequestStore + BlacklistEscalationHandler + PrismaBlacklistRepository.
// TEST_DATABASE_URL байхгүй бол БҮГД алгасагдана (docs/00-foundation.md §4). Тест бүр өвөрмөц org-той.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../../prisma.service';
import { ChangeHandlerRegistry } from '../maker-checker/change-handler';
import { PrismaChangeRequestStore } from '../maker-checker/infra/prisma-change-request.store';
import { MakerCheckerService } from '../maker-checker/maker-checker.service';
import { actor, TestClock } from '../maker-checker/testing/fixtures';
import { BlacklistEscalationHandler } from './blacklist-escalation.handler';
import { BlacklistCreateBody, BlacklistPatchBody } from './blacklist.schemas';
import { BlacklistService } from './blacklist.service';
import { PrismaBlacklistRepository, type BlacklistPrismaClient } from './prisma-blacklist.repository';
import { adminCtx, entryInput, fakeCipher, fixedSettings } from './test-support';

const URL = process.env.TEST_DATABASE_URL;
const AUDIT = { reject: 'ESCALATE_REJECTED', cancel: 'ESCALATE_CANCELLED', expire: 'ESCALATE_EXPIRED' } as const;
const STATUS = { reject: 'REJECTED', cancel: 'CANCELLED', expire: 'EXPIRED' } as const;

describe.skipIf(!URL)('blacklist Black escalation lifecycle on PostgreSQL (F8-2)', () => {
  let prisma: PrismaService;
  let clock: TestClock;
  let mc: MakerCheckerService;
  let bl: BlacklistService;
  let org: string;

  beforeAll(() => { prisma = new PrismaService({ datasources: { db: { url: URL! } } }); }, 30_000);
  afterAll(async () => { await prisma?.$disconnect(); });
  beforeEach(() => {
    org = `it-${randomUUID().slice(0, 8)}`;
    clock = new TestClock();
    const registry = new ChangeHandlerRegistry();
    new BlacklistEscalationHandler(registry); // өөрийгөө бүртгэнэ
    mc = new MakerCheckerService(new PrismaChangeRequestStore(prisma), registry, clock);
    bl = new BlacklistService(new PrismaBlacklistRepository(prisma as unknown as BlacklistPrismaClient), fakeCipher, clock, { uuid: randomUUID }, mc, fixedSettings(12));
  });

  const ctx = () => adminCtx({ orgId: org, userId: 'it-maker', branchId: 'B1' });
  const checker = () => actor('it-checker', ['ADMIN'], null, org);
  const maker = () => actor('it-maker', ['ADMIN'], 'B1', org);
  const black = () => BlacklistCreateBody.parse(entryInput({ severity: 'BLACK' }));
  const patch = (body: Record<string, unknown>) => BlacklistPatchBody.parse(body);
  const requests = (entryId: string) => prisma.changeRequest.findMany({ where: { orgId: org, targetType: 'BLACKLIST_ENTRY', targetId: entryId } });
  const pendingOf = async (entryId: string) => (await requests(entryId)).filter((r) => r.status === 'PENDING');
  const statuses = async (entryId: string) => (await requests(entryId)).map((r) => r.status).sort();

  it.each(['reject', 'cancel', 'expire'] as const)('%s clears pendingSeverity, audits it, and a re-submit creates a new PENDING request', async (how) => {
    const entry = await bl.create(ctx(), black());
    expect(entry).toMatchObject({ isActive: false, severity: 'GREY', pendingSeverity: 'BLACK' });
    const [request] = await pendingOf(entry.id);

    if (how === 'reject') await mc.reject(checker(), request!.id, 'Баримт дутуу');
    else if (how === 'cancel') await mc.cancel(maker(), request!.id, 'буруу оруулсан');
    else {
      clock.advanceHours(73);
      expect(await mc.expireOverdue(100, { orgId: org })).toBe(1);
    }

    expect(await bl.get(ctx(), entry.id)).toMatchObject({ pendingSeverity: null, isActive: false, severity: 'GREY' });
    expect(await prisma.auditLog.count({ where: { orgId: org, entityId: entry.id, action: AUDIT[how] } })).toBe(1);

    const again = await bl.create(ctx(), black());
    expect(again).toMatchObject({ id: entry.id, pendingSeverity: 'BLACK' });
    expect(await statuses(entry.id)).toEqual(['PENDING', STATUS[how]].sort());
  });

  it('a rejected Grey -> Black escalation leaves the entry active Grey and a PATCH can ask again', async () => {
    const grey = await bl.create(ctx(), BlacklistCreateBody.parse(entryInput({ severity: 'GREY' })));
    expect(await bl.update(ctx(), grey.id, patch({ severity: 'BLACK' }))).toMatchObject({ isActive: true, severity: 'GREY', pendingSeverity: 'BLACK' });
    await mc.reject(checker(), (await pendingOf(grey.id))[0]!.id, 'Баримт дутуу');

    expect(await bl.get(ctx(), grey.id)).toMatchObject({ isActive: true, severity: 'GREY', pendingSeverity: null });
    expect(await bl.update(ctx(), grey.id, patch({ severity: 'BLACK' }))).toMatchObject({ pendingSeverity: 'BLACK' });
    expect(await pendingOf(grey.id)).toHaveLength(1);
  });

  it('approval still activates the entry as Black and clears the marker (no regression)', async () => {
    const entry = await bl.create(ctx(), black());
    await mc.approve(checker(), (await pendingOf(entry.id))[0]!.id, 'зөвшөөрлөө');

    expect(await bl.get(ctx(), entry.id)).toMatchObject({ severity: 'BLACK', isActive: true, pendingSeverity: null });
    expect(await prisma.auditLog.count({ where: { orgId: org, entityId: entry.id, action: { in: Object.values(AUDIT) } } })).toBe(0);
  });

  it('a request that is overdue but not swept yet and is replaced by a new submission keeps the entry pending for the NEW request', async () => {
    const entry = await bl.create(ctx(), black());
    clock.advanceHours(73); // анхны хүсэлт хугацаа дууссан боловч sweeper хараахан хаагаагүй
    await bl.update(ctx(), entry.id, patch({ severity: 'BLACK', isActive: true, name: 'Өөр нэр' }));

    expect(await bl.get(ctx(), entry.id)).toMatchObject({ pendingSeverity: 'BLACK', isActive: false });
    expect(await statuses(entry.id)).toEqual(['EXPIRED', 'PENDING']);
    await mc.approve(checker(), (await pendingOf(entry.id))[0]!.id, 'зөвшөөрлөө'); // хуучин hook pending-ийг цэвэрлэсэн бол энд STALE_TARGET болно

    expect(await bl.get(ctx(), entry.id)).toMatchObject({ severity: 'BLACK', isActive: true, pendingSeverity: null, name: 'Өөр нэр' });
    expect(await statuses(entry.id)).toEqual(['APPLIED', 'EXPIRED']);
  });
});
