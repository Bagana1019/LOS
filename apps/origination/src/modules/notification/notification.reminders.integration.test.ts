import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '@los/calc';
import { RunRemindersResponse } from '@los/contracts';
import { actors, createApplication, createBorrower, createCustomer, createSchedule, hasTestDb, ORG } from '../../test-utils/factories';
import { bootNotification, deliveries, NotificationEnv, resetNotification, setSetting } from './notification.test-helpers';

const TODAY = '2026-10-28';

describe.skipIf(!hasTestDb)('notification: төлөлт сануулах (ReminderService, FR-13.2)', () => {
  let env: NotificationEnv;
  beforeAll(async () => { env = await bootNotification({ manual: true }); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { await resetNotification(env); env.reminders.pageSize = 200; });

  /** ACTIVE зээл; ЭТХ-ийн эхний мөр `offsetFromToday` хоногийн дараа (сөрөг = хэтэрсэн). Дараагийн мөрүүд 30 хоногоор хол тул оролцохгүй. */
  async function seed(offsetFromToday: number, o: { status?: string; coBorrower?: boolean; guarantor?: boolean; officerId?: string | null; stale?: boolean; org?: string } = {}) {
    const org = o.org ?? ORG;
    const customer = await createCustomer(env.t.prisma, { orgId: org, phone: `9911${String(1000 + Math.floor(Math.random() * 8999))}`, email: null });
    const app = await createApplication(env.t.prisma, { orgId: org, status: o.status ?? 'ACTIVE', contractNo: `BZ-${Math.random().toString(36).slice(2, 8)}`, officerId: o.officerId === undefined ? 'officer-1' : o.officerId });
    await env.t.prisma.loanApplicationBorrower.create({ data: { orgId: org, applicationId: app.id, customerId: customer.id, role: 'PRIMARY', isPrimary: true, incomeIncluded: true } });
    let co = null; let guarantor = null;
    if (o.coBorrower) { co = await createCustomer(env.t.prisma, { phone: '88110001', email: null }); await createBorrower(env.t.prisma, app.id, co.id, 'CO_BORROWER'); }
    if (o.guarantor) { guarantor = await createCustomer(env.t.prisma, { phone: '88110002', email: null }); await createBorrower(env.t.prisma, app.id, guarantor.id, 'GUARANTOR'); }
    const schedule = await createSchedule(env.t.prisma, app.id, { firstDue: addDays(TODAY, offsetFromToday), stale: o.stale });
    return { app, customer, co, guarantor, schedule, row: schedule.rows[0] };
  }
  const run = (opts: { asOf?: string; dryRun?: boolean } = {}) => env.reminders.run(ORG, opts);

  describe('хуваарь (сануулах хоногууд)', () => {
    it.each([[3, 'UPCOMING'], [1, 'UPCOMING'], [0, 'DUE_TODAY']])('төлөх өдрөөс %i хоногийн өмнө → PAYMENT_DUE (%s)', async (offset) => {
      const { app, customer, row } = await seed(offset);
      const res = RunRemindersResponse.parse(await run());
      expect(res).toEqual({ asOf: TODAY, scannedInstallments: 1, scheduledDeliveries: 1, skippedDuplicates: 0, dryRun: false });
      const rows = await deliveries(env);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'PAYMENT_DUE', channel: 'SMS', recipientId: customer.id, applicationId: app.id, status: 'QUEUED', dedupeKey: `reminder:${row.id}:${offset === 0 ? 'DUE_TODAY' : 'UPCOMING'}:${offset}:${customer.id}:SMS` });
      expect(rows[0].payloadJson).toMatchObject({ applicationNo: app.appNo, contractNo: app.contractNo, dueDate: addDays(TODAY, offset), daysOverdue: 0, amount: Number(row.total), currency: 'MNT' });
      expect(rows[0].body).toContain(app.contractNo!);
      expect(rows[0].body).toContain(addDays(TODAY, offset));
      expect(await env.t.prisma.notification.count()).toBe(0); // PAYMENT_DUE-д ЗЭЗ-д хонх явуулдаггүй
    });

    it('сануулгын хоногт таарахгүй (2 хоногийн өмнө, 10 хоногийн өмнө) мөр хөндөгдөхгүй', async () => {
      await seed(2); await seed(10); await seed(-2); await seed(-15);
      expect(await run()).toMatchObject({ scannedInstallments: 0, scheduledDeliveries: 0, skippedDuplicates: 0 });
      expect(await env.t.prisma.notificationDelivery.count()).toBe(0);
    });

    it.each([[1], [3], [7]])('%i хоног хэтэрсэн → PAYMENT_OVERDUE (daysOverdue), ЗЭЗ-д хонх', async (days) => {
      const { app, customer, row } = await seed(-days);
      expect(await run()).toMatchObject({ scannedInstallments: 1, scheduledDeliveries: 1, skippedDuplicates: 0 });
      const rows = await deliveries(env);
      expect(rows[0]).toMatchObject({ type: 'PAYMENT_OVERDUE', recipientId: customer.id, dedupeKey: `reminder:${row.id}:OVERDUE:${days}:${customer.id}:SMS` });
      expect(rows[0].payloadJson).toMatchObject({ daysOverdue: days, dueDate: addDays(TODAY, -days) });
      expect(rows[0].body).toContain(`${days} хоногоор хэтэрсэн`);
      const bell = await env.t.prisma.notification.findMany();
      expect(bell).toHaveLength(1);
      expect(bell[0]).toMatchObject({ userId: 'officer-1', type: 'PAYMENT_OVERDUE', applicationId: app.id });
      expect(bell[0].payloadJson).toMatchObject({ daysOverdue: days, applicationNo: app.appNo });
    });

    it('setting-ээр хуваарь өөрчлөгдөнө (reminder_before_due_days=[5], overdue_days=[2])', async () => {
      await setSetting(env, 'notification.reminder_before_due_days', [5]);
      await setSetting(env, 'notification.reminder_overdue_days', [2]);
      await seed(5); await seed(3); await seed(-2); await seed(-1);
      expect(await run()).toMatchObject({ scannedInstallments: 2, scheduledDeliveries: 2 });
      expect((await deliveries(env)).map((r) => r.type).sort()).toEqual(['PAYMENT_DUE', 'PAYMENT_OVERDUE']);
    });

    it('setting эвдэрсэн (массив биш) бол анхдагч [3,1,0]/[1,3,7]', async () => {
      await setSetting(env, 'notification.reminder_before_due_days', 'oops');
      await setSetting(env, 'notification.reminder_overdue_days', [1.5]);
      await seed(3); await seed(-1);
      expect(await run()).toMatchObject({ scheduledDeliveries: 2 });
    });

    it('asOf өгвөл тэр өдрөөр (өнгөрсөн өдрийг ч)', async () => {
      const { row } = await seed(10); // өнөөдрөөс 10 хоногийн дараа
      expect(await run({ asOf: addDays(TODAY, 7) })).toMatchObject({ asOf: addDays(TODAY, 7), scheduledDeliveries: 1 }); // 3 хоногийн өмнө
      expect((await deliveries(env))[0].dedupeKey).toContain(`${row.id}:UPCOMING:3`);
    });
  });

  describe('хэнд, ямар зээлд', () => {
    it('PRIMARY + CO_BORROWER бүрт; GUARANTOR-т илгээхгүй', async () => {
      const { customer, co, guarantor } = await seed(1, { coBorrower: true, guarantor: true });
      expect(await run()).toMatchObject({ scheduledDeliveries: 2 });
      expect((await deliveries(env)).map((r) => r.recipientId).sort()).toEqual([customer.id, co!.id].sort());
      expect((await deliveries(env)).some((r) => r.recipientId === guarantor!.id)).toBe(false);
    });

    it('зөвхөн ACTIVE / MIGRATED зээл', async () => {
      await seed(1, { status: 'ACTIVE' }); await seed(1, { status: 'MIGRATED' });
      await seed(1, { status: 'SUBMITTED' }); await seed(1, { status: 'CLOSED' }); await seed(1, { status: 'DRAFT' });
      expect(await run()).toMatchObject({ scannedInstallments: 2, scheduledDeliveries: 2 });
    });

    it('stale ЭТХ-ийг үл тооц; stale бус хамгийн сүүлийн ЭТХ-ийг ашиглана', async () => {
      const stale = await seed(1, { stale: true });
      expect(await run()).toMatchObject({ scannedInstallments: 0, scheduledDeliveries: 0 });
      // шинэ (stale биш) ЭТХ — өөр өдөртэй: зөвхөн энэ нь үйлчилнэ
      const fresh = await createSchedule(env.t.prisma, stale.app.id, { firstDue: addDays(TODAY, 3) });
      await createSchedule(env.t.prisma, stale.app.id, { firstDue: addDays(TODAY, 1), stale: true });
      expect(await run()).toMatchObject({ scannedInstallments: 1, scheduledDeliveries: 1 });
      expect((await deliveries(env))[0].dedupeKey).toContain(`reminder:${fresh.rows[0].id}:UPCOMING:3`);
    });

    it('ЭТХ-гүй зээл, олголтын мөр (үндсэн+хүү=0) алгасагдана', async () => {
      const app = await createApplication(env.t.prisma, { status: 'ACTIVE' });
      const c = await createCustomer(env.t.prisma, { phone: '99110099' });
      await createBorrower(env.t.prisma, app.id, c.id, 'PRIMARY');
      await env.t.prisma.repaymentSchedule.create({ data: { orgId: ORG, applicationId: app.id, paramsJson: {}, rows: { create: [{ seq: 0, dueDate: new Date(`${addDays(TODAY, 1)}T00:00:00Z`), days: 0, disbursement: 1_000_000, principal: 0, interest: 0, total: 0, balance: 1_000_000 }] } } });
      await seed(1, {});
      await createApplication(env.t.prisma, { status: 'ACTIVE' }); // ЭТХ-гүй
      expect(await run()).toMatchObject({ scannedInstallments: 1, scheduledDeliveries: 1 });
    });

    it('үлдэгдлийг allocation-аар бодно: хэсэгчлэн төлсөн бол үлдэгдлээр, бүрэн төлсөн бол сануулахгүй', async () => {
      const partial = await seed(1);
      const paid = await seed(0);
      const pay = await env.t.prisma.payment.create({ data: { orgId: ORG, applicationId: partial.app.id, provider: 'BANK_TRANSFER', providerPaymentId: 'p1', amount: 1000, paidAt: env.t.clock.now() } });
      await env.t.prisma.paymentAllocation.create({ data: { paymentId: pay.id, scheduleRowId: partial.row.id, interestPaid: Number(partial.row.interest), principalPaid: 5000, totalPaid: Number(partial.row.interest) + 5000 } });
      const pay2 = await env.t.prisma.payment.create({ data: { orgId: ORG, applicationId: paid.app.id, provider: 'BANK_TRANSFER', providerPaymentId: 'p2', amount: 1000, paidAt: env.t.clock.now() } });
      await env.t.prisma.paymentAllocation.create({ data: { paymentId: pay2.id, scheduleRowId: paid.row.id, interestPaid: Number(paid.row.interest), principalPaid: Number(paid.row.principal), totalPaid: Number(paid.row.total) } });
      expect(await run()).toMatchObject({ scannedInstallments: 2, scheduledDeliveries: 1 });
      const rows = await deliveries(env);
      expect(rows).toHaveLength(1);
      expect(rows[0].applicationId).toBe(partial.app.id);
      expect(rows[0].payloadJson).toMatchObject({ amount: Math.round((Number(partial.row.principal) - 5000) * 100) / 100 }); // хүү бүрэн төлөгдсөн, үндсэн 5000 төлөгдсөн
    });
  });

  describe('давхардал, dry-run, зэрэгцээ', () => {
    it('нэг өдөрт хоёр удаа ажиллуулахад давхар илгээхгүй; ЗЭЗ-д хонх нэг л удаа', async () => {
      await seed(-3, { coBorrower: true });
      expect(await run()).toMatchObject({ scheduledDeliveries: 2, skippedDuplicates: 0 });
      expect(await run()).toMatchObject({ scheduledDeliveries: 0, skippedDuplicates: 2 });
      expect(await env.t.prisma.notificationDelivery.count()).toBe(2);
      expect(await env.t.prisma.notification.count()).toBe(1);
    });

    it('маргааш (өөр offset) шинэ сануулга зөвшөөрөгдөнө: 3 хоногийн өмнө, дараа нь 1 хоногийн өмнө', async () => {
      await seed(3);
      await run();
      expect(await run({ asOf: addDays(TODAY, 2) })).toMatchObject({ scheduledDeliveries: 1 });
      expect(await run({ asOf: addDays(TODAY, 1) })).toMatchObject({ scheduledDeliveries: 0, scannedInstallments: 0 }); // 2 хоногийн өмнө — хуваарьт байхгүй
      expect(await env.t.prisma.notificationDelivery.count()).toBe(2);
    });

    it('dryRun: тоог хэлнэ, юу ч бичихгүй (хүргэлт ч, хонх ч)', async () => {
      await seed(-1, { coBorrower: true }); await seed(0);
      const dry = await run({ dryRun: true });
      expect(dry).toEqual({ asOf: TODAY, scannedInstallments: 2, scheduledDeliveries: 3, skippedDuplicates: 0, dryRun: true });
      expect(await env.t.prisma.notificationDelivery.count()).toBe(0);
      expect(await env.t.prisma.notification.count()).toBe(0);
      expect(env.manual!.enqueued).toHaveLength(0);
      const real = await run();
      expect(real).toMatchObject({ scheduledDeliveries: 3, dryRun: false });
      expect(await run({ dryRun: true })).toMatchObject({ scheduledDeliveries: 0, skippedDuplicates: 3 });
    });

    it('зэрэгцээ 3 ажиллуулалт: хүргэлт давхардахгүй, ЗЭЗ-д хонх нэг л удаа', async () => {
      await seed(-1); await seed(-7); await seed(1);
      const results = await Promise.all([run(), run(), run()]);
      expect(results.reduce((s, r) => s + r.scheduledDeliveries, 0)).toBe(3);
      expect(await env.t.prisma.notificationDelivery.count()).toBe(3);
      expect(await env.t.prisma.notification.count()).toBe(2); // OVERDUE 2
    });

    it('officerId=null ("Систем") зээл: хонх үүсэхгүй, хүргэлт хэвийн', async () => {
      await seed(-1, { officerId: null });
      expect(await run()).toMatchObject({ scheduledDeliveries: 1 });
      expect(await env.t.prisma.notification.count()).toBe(0);
    });

    it('утасгүй/имэйлгүй зээлдэгч — ЗЭЗ-д хонх ч үүсэхгүй (хүргэлт шинээр үүсээгүй)', async () => {
      const s = await seed(-1);
      await env.t.prisma.customer.update({ where: { id: s.customer.id }, data: { phone: null } });
      expect(await run()).toMatchObject({ scheduledDeliveries: 0 });
      expect(await env.t.prisma.notification.count()).toBe(0);
    });

    it('буруу утастай зээлдэгч: SKIPPED хүргэлт бүртгэгдэнэ, ЗЭЗ-д хонх очно, scheduled-д тоологдохгүй', async () => {
      const s = await seed(-1);
      await env.t.prisma.customer.update({ where: { id: s.customer.id }, data: { phone: '123' } });
      expect(await run()).toMatchObject({ scheduledDeliveries: 0, skippedDuplicates: 0 });
      expect((await deliveries(env))[0]).toMatchObject({ status: 'SKIPPED', lastError: 'INVALID_ADDRESS' });
      expect(await env.t.prisma.notification.count()).toBe(1);
    });
  });

  it('багцаар (cursor) боловсруулна: pageSize=2, 5 зээл → бүгд, давхардалгүй', async () => {
    env.reminders.pageSize = 2;
    for (let i = 0; i < 5; i++) await seed(1);
    expect(await run()).toMatchObject({ scannedInstallments: 5, scheduledDeliveries: 5 });
    expect(await env.t.prisma.notificationDelivery.count()).toBe(5);
    env.reminders.pageSize = 5; // яг хуудасны хэмжээтэй тэнцүү үед ч зогсоно
    expect(await run()).toMatchObject({ scheduledDeliveries: 0, skippedDuplicates: 5 });
  });

  it('нэг зээлийн алдаа бусдын сануулгыг зогсоохгүй; дараагийн ажиллалтаар нөхөгдөнө', async () => {
    await seed(1); await seed(1); await seed(1);
    vi.spyOn(env.service, 'notifyCustomers').mockRejectedValueOnce(new Error('түр алдаа'));
    expect(await run()).toMatchObject({ scannedInstallments: 3, scheduledDeliveries: 2 });
    vi.restoreAllMocks();
    expect(await run()).toMatchObject({ scheduledDeliveries: 1, skippedDuplicates: 2 });
    expect(await env.t.prisma.notificationDelivery.count()).toBe(3);
  });

  it('runAllOrgs: ACTIVE зээлтэй байгууллага бүрт өөрийн org-оор', async () => {
    await seed(1);
    const other = await seed(1, { org: 'org-b' });
    const results = await env.reminders.runAllOrgs();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.scheduledDeliveries)).toEqual([1, 1]);
    const rows = await deliveries(env);
    expect(rows.map((r) => r.orgId).sort()).toEqual(['org-b', ORG]);
    expect(rows.find((r) => r.orgId === 'org-b')!.applicationId).toBe(other.app.id);
  });

  it('inline queue: сануулга шууд илгээгдэнэ (mock SMS outbox)', async () => {
    const inline = await bootNotification();
    try {
      await resetNotification(inline);
      const customer = await createCustomer(inline.t.prisma, { phone: '99112233', email: null });
      const app = await createApplication(inline.t.prisma, { status: 'ACTIVE', contractNo: 'BZ-9' });
      await createBorrower(inline.t.prisma, app.id, customer.id, 'PRIMARY');
      await createSchedule(inline.t.prisma, app.id, { firstDue: addDays(TODAY, -3) });
      expect(await inline.reminders.run(ORG)).toMatchObject({ scheduledDeliveries: 1 });
      expect(inline.sms.outbox).toHaveLength(1);
      expect(inline.sms.outbox[0].to).toBe('+97699112233');
      expect(inline.sms.outbox[0].text).toContain('BZ-9');
    } finally { await inline.t.close(); }
  });

  describe('POST /notifications/reminders/run', () => {
    it('эрх: 401 / OFFICER 403 / BRANCH_MANAGER 403 / ADMIN 200', async () => {
      await env.http().post('/api/notifications/reminders/run').set(actors.anonymous()).send({}).expect(401);
      await env.http().post('/api/notifications/reminders/run').set(actors.officer()).send({}).expect(403);
      await env.http().post('/api/notifications/reminders/run').set(actors.branchManager()).send({}).expect(403);
      await env.http().post('/api/notifications/reminders/run').set(actors.customer('c1')).send({}).expect(403);
      await env.http().post('/api/notifications/reminders/run').set(actors.admin()).send({}).expect(200);
    });

    it('хоосон body-той ч ажиллана; dryRun, asOf; DTO-д таарна', async () => {
      await seed(1);
      const dry = await env.http().post('/api/notifications/reminders/run').set(actors.admin()).send({ dryRun: true }).expect(200);
      expect(RunRemindersResponse.parse(dry.body)).toEqual({ asOf: TODAY, scannedInstallments: 1, scheduledDeliveries: 1, skippedDuplicates: 0, dryRun: true });
      const real = await env.http().post('/api/notifications/reminders/run').set(actors.admin()).expect(200);
      expect(real.body).toMatchObject({ scheduledDeliveries: 1, dryRun: false });
      const again = await env.http().post('/api/notifications/reminders/run').set(actors.admin()).send({}).expect(200);
      expect(again.body).toMatchObject({ scheduledDeliveries: 0, skippedDuplicates: 1 });
    });

    it('буруу asOf → 400 VALIDATION_FAILED', async () => {
      const res = await env.http().post('/api/notifications/reminders/run').set(actors.admin()).send({ asOf: '28/10/2026' }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      await env.http().post('/api/notifications/reminders/run').set(actors.admin()).send({ dryRun: 'yes' }).expect(400);
    });

    it('ADMIN өөрийн байгууллагынхыг л ажиллуулна', async () => {
      await seed(1, { org: 'org-b' });
      const res = await env.http().post('/api/notifications/reminders/run').set(actors.admin()).send({}).expect(200);
      expect(res.body).toMatchObject({ scannedInstallments: 0, scheduledDeliveries: 0 });
    });
  });
});
