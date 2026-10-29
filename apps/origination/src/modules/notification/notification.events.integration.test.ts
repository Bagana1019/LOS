import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainEvents } from '../../shared/domain-events';
import { OrgSettings } from '../../shared/org-settings';
import { TemplateService } from './template.service';
import { OutboxRelayService } from '../../test-utils/test-app';
import { parseRequestContext } from '@los/nest-common';
import { actors, createApplication, createBorrower, createCustomer, hasTestDb } from '../../test-utils/factories';
import { bootNotification, deliveries, NotificationEnv, publish, resetNotification } from './notification.test-helpers';

describe.skipIf(!hasTestDb)('notification: NotificationEventConsumer (bus → мэдэгдэл)', () => {
  let env: NotificationEnv;
  beforeAll(async () => { env = await bootNotification(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetNotification(env); });

  async function seed(o: { officerId?: string | null; coBorrower?: boolean; guarantor?: boolean; contractNo?: string | null } = {}) {
    const primary = await createCustomer(env.t.prisma, { firstName: 'Болд', phone: '99112233', email: 'bold@example.mn' });
    const app = await createApplication(env.t.prisma, { status: 'APPROVED', amount: 12_000_000, contractNo: o.contractNo === undefined ? 'BZ-2026-0001' : o.contractNo, officerId: o.officerId === undefined ? 'officer-1' : o.officerId });
    await createBorrower(env.t.prisma, app.id, primary.id, 'PRIMARY');
    const co = o.coBorrower ? await createCustomer(env.t.prisma, { firstName: 'Сараа', phone: '88112233', email: null }) : null;
    if (co) await createBorrower(env.t.prisma, app.id, co.id, 'CO_BORROWER');
    const guarantor = o.guarantor ? await createCustomer(env.t.prisma, { firstName: 'Гэрэл', phone: '88119999', email: 'g@example.mn' }) : null;
    if (guarantor) await createBorrower(env.t.prisma, app.id, guarantor.id, 'GUARANTOR');
    return { app, primary, co, guarantor };
  }

  describe('ApplicationApproved', () => {
    it('PRIMARY + CO_BORROWER-д APPROVED (SMS/EMAIL), ЗЭЗ-д хонх; GUARANTOR-т илгээхгүй', async () => {
      const { app, primary, guarantor } = await seed({ coBorrower: true, guarantor: true });
      const ev = await publish(env, { type: 'ApplicationApproved', applicationId: app.id, contractNo: 'BZ-2026-0001' });
      const rows = await deliveries(env);
      expect(rows.map((r) => `${r.recipientId === primary.id ? 'primary' : 'co'}:${r.channel}`).sort()).toEqual(['co:SMS', 'primary:EMAIL', 'primary:SMS']);
      expect(rows.some((r) => r.recipientId === guarantor!.id)).toBe(false);
      for (const r of rows) expect(r).toMatchObject({ type: 'APPROVED', status: 'SENT', applicationId: app.id, recipientType: 'CUSTOMER' });
      expect(rows[0].dedupeKey.startsWith(`event:${ev.eventId}:`)).toBe(true);
      expect(env.sms.outbox.map((m) => m.to).sort()).toEqual(['+97688112233', '+97699112233']);
      const smsToPrimary = env.sms.outbox.find((m) => m.to === '+97699112233')!;
      expect(smsToPrimary.text).toBe('Болд, таны 12,000,000 MNT-ийн зээл батлагдлаа. Гэрээний дугаар: BZ-2026-0001.');
      expect(env.sms.outbox.find((m) => m.to === '+97688112233')!.text.startsWith('Сараа,')).toBe(true);
      expect(env.email.outbox[0].subject).toBe('Таны зээлийн хүсэлт батлагдлаа');

      const bell = await env.t.prisma.notification.findMany();
      expect(bell).toHaveLength(1);
      expect(bell[0]).toMatchObject({ userId: 'officer-1', type: 'APPROVED', applicationId: app.id });
      const list = await env.http().get('/api/notifications').set(actors.officer('officer-1')).expect(200);
      expect(list.body.items[0]).toMatchObject({ title: 'Хүсэлт батлагдлаа', body: `${app.appNo} дугаартай хүсэлт батлагдлаа. Гэрээний дугаар: BZ-2026-0001.` });
    });

    it('idempotent: ижил eventId дахин хүргэгдэхэд давхар илгээхгүй; өөр eventId (дахин батлалт) шинээр', async () => {
      const { app } = await seed();
      const ev = await publish(env, { type: 'ApplicationApproved', applicationId: app.id, contractNo: 'BZ-2026-0001' });
      const smsBefore = env.sms.outbox.length;
      await publish(env, { type: 'ApplicationApproved', applicationId: app.id, contractNo: 'BZ-2026-0001' }, ev.eventId);
      expect(env.sms.outbox).toHaveLength(smsBefore);
      expect(await env.t.prisma.notification.count()).toBe(1);
      expect(await env.t.prisma.processedEvent.count({ where: { consumer: 'notification', eventId: ev.eventId } })).toBe(1);
      await publish(env, { type: 'ApplicationApproved', applicationId: app.id, contractNo: 'BZ-2026-0001' });
      expect(env.sms.outbox).toHaveLength(smsBefore + 1);
    });

    it('зэрэгцээ ижил event: нэг л удаа боловсруулагдана', async () => {
      const { app } = await seed();
      const ev = { type: 'ApplicationApproved', applicationId: app.id, contractNo: 'BZ-2026-0001' } as const;
      const eventId = '6f9c2a52-6a39-4a6c-9d3e-0d4b3e8e2b11';
      await Promise.all(Array.from({ length: 5 }, () => publish(env, ev, eventId)));
      expect(await env.t.prisma.notification.count()).toBe(1);
      expect(env.sms.outbox).toHaveLength(1);
      expect(env.email.outbox).toHaveLength(1);
    });

    it('тохиргоо, загварыг транзакцийн ГАДНА ачаална (дотроос pool-д хандвал зэрэг ирсэн event-үүд pool дүүрч гацна)', async () => {
      const { app } = await seed();
      const prisma = env.t.prisma;
      const settings = env.t.app.get(OrgSettings);
      const templates = env.t.app.get(TemplateService);
      let open = 0;
      const insideTx: string[] = [];
      const realTx = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>;
      vi.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, ...rest: unknown[]) => typeof fn !== 'function' ? realTx(fn, ...rest)
        : realTx(async (tx: unknown) => { open++; try { return await (fn as (t: unknown) => Promise<unknown>)(tx); } finally { open--; } }, ...rest)) as never);
      const realGet = settings.get.bind(settings);
      vi.spyOn(settings, 'get').mockImplementation(((...a: Parameters<typeof realGet>) => { if (open > 0) insideTx.push(`settings:${a[1]}`); return realGet(...a); }) as never);
      const realResolver = templates.resolver.bind(templates);
      vi.spyOn(templates, 'resolver').mockImplementation(((orgId: string) => { if (open > 0) insideTx.push('templates'); return realResolver(orgId); }) as never);
      try {
        await publish(env, { type: 'ApplicationApproved', applicationId: app.id, contractNo: 'BZ-2026-0001' });
        expect(env.sms.outbox).toHaveLength(1);
        expect(insideTx).toEqual([]);
      } finally { vi.restoreAllMocks(); }
    });

    it('officerId=null (Систем) бол хонх үүсэхгүй, зээлдэгчид явна', async () => {
      const { app } = await seed({ officerId: null });
      await publish(env, { type: 'ApplicationApproved', applicationId: app.id, contractNo: 'BZ-2026-0001' });
      expect(await env.t.prisma.notification.count()).toBe(0);
      expect(env.sms.outbox).toHaveLength(1);
    });
  });

  it('outbox → relay → bus → consumer: DomainEvents.publish хийсэн event мэдэгдэл болно (бүтэн гинж)', async () => {
    const { app } = await seed();
    const ctx = parseRequestContext({ ...actors.officer('officer-9'), 'x-correlation-id': 'corr-e2e' });
    await env.t.prisma.$transaction((tx) => env.t.app.get(DomainEvents).publish(tx, { type: 'ApplicationApproved', applicationId: app.id, contractNo: 'BZ-2026-0001' }, ctx));
    expect(env.sms.outbox).toHaveLength(0); // relay хүртэл юу ч болоогүй
    expect(await env.t.app.get(OutboxRelayService).relayOnce()).toBe(1);
    expect(env.sms.outbox).toHaveLength(1);
    expect(env.sms.outbox[0].text).toContain('BZ-2026-0001');
    expect(await env.t.prisma.notification.count()).toBe(1);
    expect(await env.t.app.get(OutboxRelayService).relayOnce()).toBe(0);
  });

  describe('ApplicationReturned', () => {
    it('ЗЭЗ-д RETURNED хонх (тайлбар, түвшин); зээлдэгчид мэдэгдэхгүй', async () => {
      const { app } = await seed();
      await publish(env, { type: 'ApplicationReturned', applicationId: app.id, levelNo: 2, comment: 'Орлогын баримт дутуу' });
      const bell = await env.t.prisma.notification.findMany();
      expect(bell).toHaveLength(1);
      expect(bell[0]).toMatchObject({ userId: 'officer-1', type: 'RETURNED', applicationId: app.id });
      expect(bell[0].payloadJson).toMatchObject({ comment: 'Орлогын баримт дутуу', levelNo: 2, applicationNo: app.appNo });
      expect(await env.t.prisma.notificationDelivery.count()).toBe(0);
      const list = await env.http().get('/api/notifications').set(actors.officer('officer-1')).expect(200);
      expect(list.body.items[0].body).toBe(`${app.appNo} дугаартай хүсэлт буцаагдлаа. Тайлбар: Орлогын баримт дутуу`);
    });
  });

  describe('DisbursementApproved', () => {
    it('зээлдэгчид DISBURSEMENT_APPROVED (SMS/EMAIL) + ЗЭЗ-д хонх; дүн нь event-ийн дүн', async () => {
      const { app } = await seed();
      await publish(env, { type: 'DisbursementApproved', applicationId: app.id, amount: 11_500_000, coreLoanId: 'CORE-1' });
      expect(env.sms.outbox[0].text).toBe('Болд, таны BZ-2026-0001 гэрээний 11,500,000 MNT зээлийн олголт зөвшөөрөгдлөө.');
      expect(env.email.outbox[0].subject).toBe('Таны зээлийн олголт зөвшөөрөгдлөө');
      expect((await deliveries(env)).every((r) => r.type === 'DISBURSEMENT_APPROVED')).toBe(true);
      expect(await env.t.prisma.notification.findFirstOrThrow()).toMatchObject({ userId: 'officer-1', type: 'DISBURSEMENT_APPROVED' });
    });
  });

  describe('PaymentReceived', () => {
    it('зээлдэгчид PAYMENT_RECEIVED баримт (SMS/EMAIL); ЗЭЗ-д хонх үүсгэхгүй', async () => {
      const { app } = await seed();
      await publish(env, { type: 'PaymentReceived', paymentId: 'pay-1', applicationId: app.id, provider: 'QPAY', amount: 250_000, currency: 'MNT', paidAt: env.t.clock.now().toISOString(), unallocatedAmount: 0, scheduleRowIds: [] });
      expect(env.sms.outbox[0].text).toBe('Болд, таны BZ-2026-0001 зээлд 250,000 MNT төлбөр хүлээн авлаа. Баярлалаа.');
      expect(env.email.outbox).toHaveLength(1);
      expect(await env.t.prisma.notification.count()).toBe(0);
    });

    it('өөр өөр төлбөр (eventId) бүр өөрийн баримт авна', async () => {
      const { app } = await seed();
      const body = { type: 'PaymentReceived' as const, applicationId: app.id, provider: 'BANK_TRANSFER' as const, amount: 1000, currency: 'MNT', paidAt: env.t.clock.now().toISOString(), unallocatedAmount: 0, scheduleRowIds: [] };
      await publish(env, { ...body, paymentId: 'p1' });
      await publish(env, { ...body, paymentId: 'p2' });
      expect(env.sms.outbox).toHaveLength(2);
    });
  });

  describe('алдаа тэсвэрлэлт', () => {
    it('хүсэлт олдохгүй бол алдаа шидэхгүй, юу ч үүсгэхгүй, event боловсруулсан гэж тэмдэглэнэ', async () => {
      const ev = await publish(env, { type: 'ApplicationApproved', applicationId: 'no-such-app', contractNo: 'X' });
      expect(await env.t.prisma.notificationDelivery.count()).toBe(0);
      expect(await env.t.prisma.notification.count()).toBe(0);
      expect(await env.t.prisma.processedEvent.count({ where: { eventId: ev.eventId } })).toBe(1);
    });

    it('зээлдэгчгүй хүсэлт: хонх явна, хүргэлт үүсэхгүй', async () => {
      const app = await createApplication(env.t.prisma, { status: 'APPROVED', contractNo: 'BZ-1' });
      await publish(env, { type: 'ApplicationApproved', applicationId: app.id, contractNo: 'BZ-1' });
      expect(await env.t.prisma.notificationDelivery.count()).toBe(0);
      expect(await env.t.prisma.notification.count()).toBe(1);
    });

    it('өөр байгууллагын event-д хандахгүй (orgId таарахгүй хүсэлт олдохгүй)', async () => {
      const other = await createApplication(env.t.prisma, { orgId: 'other-org', status: 'APPROVED' });
      await publish(env, { type: 'ApplicationApproved', applicationId: other.id, contractNo: 'X' });
      expect(await env.t.prisma.notification.count()).toBe(0);
    });

    it('DB алдаа гарвал marker rollback болж, дахин хүргэхэд боловсруулагдана (at-least-once)', async () => {
      const { app } = await seed();
      const ev = { type: 'ApplicationApproved', applicationId: app.id, contractNo: 'BZ-2026-0001' } as const;
      const eventId = '0a4b9f4e-4a0f-4c1b-9f0e-2f6d1f0c7a21';
      // tx дотор Prisma-г хуурамчлах боломжгүй тул нэг удаа алдаа гаргах consumer.apply-ийг түр солино
      const original = (env.consumer as unknown as { apply: (...a: unknown[]) => Promise<string[]> }).apply;
      let calls = 0;
      (env.consumer as unknown as { apply: unknown }).apply = async (...a: unknown[]) => { if (calls++ === 0) throw new Error('түр алдаа'); return original.apply(env.consumer, a); };
      try {
        await expect(publish(env, ev, eventId)).rejects.toThrow('түр алдаа');
        expect(await env.t.prisma.processedEvent.count({ where: { eventId } })).toBe(0);
        await publish(env, ev, eventId);
        expect(env.sms.outbox).toHaveLength(1);
      } finally { (env.consumer as unknown as { apply: unknown }).apply = original; }
    });

    it('боловсруулдаггүй төрлийн event (ApplicationSubmitted) хандахгүй', async () => {
      const { app } = await seed();
      await publish(env, { type: 'ApplicationSubmitted', applicationId: app.id, amount: 1, productId: 'p' });
      expect(await env.t.prisma.notification.count()).toBe(0);
      expect(await env.t.prisma.processedEvent.count()).toBe(0);
    });
  });

  it('gateway түр унасан бол мэдэгдэл QUEUED үлдэж, event-ийг дахин боловсруулах шаардлагагүй (sweep/backoff)', async () => {
    const { app } = await seed();
    env.sms.failNext(1, { retryable: true });
    await publish(env, { type: 'ApplicationApproved', applicationId: app.id, contractNo: 'BZ-2026-0001' });
    const sms = await env.t.prisma.notificationDelivery.findFirstOrThrow({ where: { channel: 'SMS' } });
    expect(sms).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: 'PROVIDER_ERROR' });
    env.t.clock.advanceMs(30_000);
    await env.processor.sweep();
    expect((await env.t.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: sms.id } })).status).toBe('SENT');
    expect(env.sms.outbox).toHaveLength(1);
  });
});
