import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { actors, hasTestDb } from '../../test-utils/factories';
import { accountsFor } from '../../integrations/core-deposit/core-deposit.mock';
import { bootReport, col, getReport, resetAndSeed, ReportEnv } from './report.test-helpers';
import type { World } from './report.fixtures';

// Хүлээгдэх утгууд report.fixtures.ts-ийн тайлбар дахь өгөгдлөөс ГАРААР тооцсон. asOf = 2026-10-28.
describe.skipIf(!hasTestDb)('9 тайлангийн SQL (бодит Postgres, HTTP)', () => {
  let env: ReportEnv;
  let w: World;
  const admin = actors.admin();
  beforeAll(async () => { env = await bootReport(); });
  afterAll(async () => { await env.t.close(); });
  beforeEach(async () => { w = await resetAndSeed(env); });

  describe('upcoming-repayments', () => {
    it('анхдагч цонх [asOf, asOf+30]: үлдэгдэлтэй мөрүүд, төлөх огноогоор; олон валют тул нийлбэргүй', async () => {
      const r = await getReport(env, admin, 'upcoming-repayments');
      expect(r.asOf).toBe('2026-10-28');
      expect(r.total).toBe(5);
      expect(col(r, 'contractNo')).toEqual(['B10026LB', 'B10026LC', 'B10026LA', 'B10026LN', 'B10026LD']);
      expect(col(r, 'dueDate')).toEqual(['2026-10-28', '2026-11-01', '2026-11-10', '2026-11-12', '2026-11-15']);
      expect(col(r, 'daysUntilDue')).toEqual([0, 4, 13, 15, 18]);
      expect(r.mixedCurrency).toBe(true);
      expect(r.totals).toBeUndefined();
      // LB: мөр1 — хүү 5k төлсөн
      expect(r.rows[0]).toMatchObject({ customerName: 'Дорж Сараа', registerNo: 'УБ****0002', phone: '99000002', seq: 1, interest: 5000, principal: 100000, total: 105000, paidAmount: 5000, outstanding: 100000, currency: 'MNT', branchId: 'branch-1', officerId: 'officer-1' });
      expect(r.rows[1]).toMatchObject({ seq: 5, interest: 20000, principal: 200000, total: 220000, paidAmount: 0, outstanding: 220000, branchId: 'branch-2' });
      expect(r.rows[2]).toMatchObject({ seq: 4, total: 110000, outstanding: 110000 });
      expect(r.rows[4]).toMatchObject({ contractNo: 'B10026LD', currency: 'USD', seq: 3, total: 1100, outstanding: 1100 });
    });

    it('currency=MNT: нийлбэр бүх шүүлттэй мөрөөр', async () => {
      const r = await getReport(env, admin, 'upcoming-repayments', { currency: 'MNT' });
      expect(r.total).toBe(4);
      expect(r.mixedCurrency).toBeUndefined();
      expect(r.totals).toEqual({ interest: 40000, principal: 650000, total: 690000, paidAmount: 5000, outstanding: 685000 });
    });

    it('хуудаслалттай ч нийлбэр нь бүх мөрийнх (хуудсаар биш)', async () => {
      const r = await getReport(env, admin, 'upcoming-repayments', { currency: 'MNT', pageSize: 10, sortBy: 'total', sortDir: 'desc' });
      expect(col(r, 'total')).toEqual([255000, 220000, 110000, 105000]);
      expect(r.totals?.total).toBe(690000);
    });

    it('цонхны хил: dateTo=11-27 → LB мөр2 (11-28) орохгүй; 11-28 бол орно', async () => {
      const a = await getReport(env, admin, 'upcoming-repayments', { currency: 'MNT', dateTo: '2026-11-28' });
      expect(a.total).toBe(5);
      expect(col(a, 'dueDate')).toContain('2026-11-28');
      const b = await getReport(env, admin, 'upcoming-repayments', { currency: 'MNT', dateTo: '2026-11-27' });
      expect(col(b, 'dueDate')).not.toContain('2026-11-28');
    });

    it('dateFrom: өмнөх огноотой (хугацаа хэтэрсэн) мөр орно, төлөгдсөн мөр орохгүй', async () => {
      const r = await getReport(env, admin, 'upcoming-repayments', { currency: 'MNT', dateFrom: '2026-09-01', dateTo: '2026-10-27' });
      // төлөх огноогоор: LC 09-01, LA 09-10 (үлдэгдэл 60,000), LC 10-01, LA 10-10. LA мөр1 (08-10) цонхноос өмнө, LB (10-28) цонхноос хойно.
      expect(col(r, 'contractNo')).toEqual(['B10026LC', 'B10026LA', 'B10026LC', 'B10026LA']);
      expect(col(r, 'dueDate')).toEqual(['2026-09-01', '2026-09-10', '2026-10-01', '2026-10-10']);
      expect(col(r, 'outstanding')).toEqual([220000, 60000, 220000, 110000]);
      expect(r.rows[1]).toMatchObject({ seq: 2, interest: 10000, principal: 100000, paidAmount: 50000, outstanding: 60000 });
    });

    it('status=MIGRATED → зөвхөн LD; ACTIVE → LD орохгүй', async () => {
      expect(col(await getReport(env, admin, 'upcoming-repayments', { status: 'MIGRATED' }), 'contractNo')).toEqual(['B10026LD']);
      expect(col(await getReport(env, admin, 'upcoming-repayments', { status: 'ACTIVE' }), 'contractNo')).not.toContain('B10026LD');
    });

    it('stale ЭТХ-тэй (LE) болон хаагдсан/ноорог зээл орохгүй', async () => {
      const r = await getReport(env, admin, 'upcoming-repayments', { dateFrom: '2026-01-01', dateTo: '2027-12-31' });
      expect(col(r, 'contractNo')).not.toContain('B10026LE');
      expect(col(r, 'contractNo')).not.toContain('B10026LF');
    });
  });

  describe('overdue-loans', () => {
    it('зээл тутамд хамгийн эртний хэтэрсэн мөрөөс DPD, DPD буурах эрэмбэ', async () => {
      const r = await getReport(env, admin, 'overdue-loans');
      expect(r.total).toBe(3);
      expect(col(r, 'contractNo')).toEqual(['B10026LC', 'B10026LA', 'B10026LD']);
      expect(col(r, 'dpd')).toEqual([119, 48, 13]);
      expect(col(r, 'bucket')).toEqual(['DPD_90_PLUS', 'DPD_31_60', 'DPD_1_30']);
      expect(col(r, 'oldestDueDate')).toEqual(['2026-07-01', '2026-09-10', '2026-10-15']);
      expect(r.rows[0]).toMatchObject({ customerName: 'Чимэд Тэмүүлэн', registerNo: 'УБ****0003', overdueInstallments: 4, overduePrincipal: 800000, overdueInterest: 80000, overdueTotal: 880000, outstandingPrincipal: 1000000, currency: 'MNT', branchId: 'branch-2', officerId: 'officer-2' });
      expect(r.rows[1]).toMatchObject({ overdueInstallments: 2, overduePrincipal: 160000, overdueInterest: 10000, overdueTotal: 170000, outstandingPrincipal: 460000 });
      expect(r.rows[2]).toMatchObject({ overdueInstallments: 1, overduePrincipal: 1000, overdueInterest: 100, overdueTotal: 1100, outstandingPrincipal: 2000, currency: 'USD' });
      expect(r.mixedCurrency).toBe(true);
    });

    it('өнөөдөр төлөх мөр (LB) хэтэрсэнд тооцогдохгүй; дараагийн өдөр (asOf=10-29) DPD=1', async () => {
      expect(col(await getReport(env, admin, 'overdue-loans'), 'contractNo')).not.toContain('B10026LB');
      const r = await getReport(env, admin, 'overdue-loans', { asOf: '2026-10-29', search: 'B10026LB' });
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ dpd: 1, bucket: 'DPD_1_30', overdueInstallments: 1, overduePrincipal: 100000, overdueInterest: 0, outstandingPrincipal: 300000 });
    });

    it('currency=MNT нийлбэр; ангиллаар шүүх; эрэмбэ', async () => {
      const r = await getReport(env, admin, 'overdue-loans', { currency: 'MNT' });
      expect(r.totals).toEqual({ overdueInstallments: 6, overduePrincipal: 960000, overdueInterest: 90000, overdueTotal: 1050000, outstandingPrincipal: 1460000 });
      expect(col(await getReport(env, admin, 'overdue-loans', { status: 'DPD_31_60' }), 'contractNo')).toEqual(['B10026LA']);
      expect(col(await getReport(env, admin, 'overdue-loans', { status: 'DPD_90_PLUS' }), 'contractNo')).toEqual(['B10026LC']);
      expect(col(await getReport(env, admin, 'overdue-loans', { status: 'DPD_61_90' }), 'contractNo')).toEqual([]);
      expect(col(await getReport(env, admin, 'overdue-loans', { sortBy: 'bucket', sortDir: 'asc' }), 'bucket')).toEqual(['DPD_1_30', 'DPD_31_60', 'DPD_90_PLUS']);
      expect(col(await getReport(env, admin, 'overdue-loans', { sortBy: 'overdueTotal', sortDir: 'asc' }), 'overdueTotal')).toEqual([1100, 170000, 880000]);
    });
  });

  describe('outstanding-balance', () => {
    it('ACTIVE/MIGRATED зээл тутамд олгосон, төлсөн, үлдэгдэл, дараагийн төлөлт', async () => {
      const r = await getReport(env, admin, 'outstanding-balance');
      expect(col(r, 'contractNo')).toEqual(['B10026LC', 'B10026LE', 'B10026LA', 'B10026LB', 'B10026LN', 'B10026LD']);
      const byNo = Object.fromEntries(r.rows.map((x) => [x.contractNo as string, x]));
      expect(byNo.B10026LA).toMatchObject({ productName: 'Хэрэглээний зээл', status: 'ACTIVE', disbursedAmount: 600000, paidPrincipal: 140000, outstandingPrincipal: 460000, outstandingInterest: 10000, nextDueDate: '2026-11-10', nextDueAmount: 110000 });
      expect(byNo.B10026LB).toMatchObject({ disbursedAmount: 300000, paidPrincipal: 0, outstandingPrincipal: 300000, outstandingInterest: 0, nextDueDate: '2026-10-28', nextDueAmount: 100000 });
      expect(byNo.B10026LC).toMatchObject({ disbursedAmount: 1000000, paidPrincipal: 0, outstandingPrincipal: 1000000, outstandingInterest: 80000, nextDueDate: '2026-11-01', nextDueAmount: 220000 });
      expect(byNo.B10026LD).toMatchObject({ status: 'MIGRATED', currency: 'USD', disbursedAmount: 3000, paidPrincipal: 1000, outstandingPrincipal: 2000, outstandingInterest: 100, nextDueDate: '2026-11-15', nextDueAmount: 1100 });
      // ЭТХ-гүй (зөвхөн stale) → үлдэгдэл = зээлийн дүн
      expect(byNo.B10026LE).toMatchObject({ disbursedAmount: 500000, paidPrincipal: 0, outstandingPrincipal: 500000, outstandingInterest: 0, nextDueDate: null, nextDueAmount: null });
      expect(byNo.B10026LN).toMatchObject({ disbursedAmount: 250000, outstandingPrincipal: 250000, nextDueDate: '2026-11-12', nextDueAmount: 255000 });
    });

    it('currency=MNT нийлбэр; status шүүлт', async () => {
      const r = await getReport(env, admin, 'outstanding-balance', { currency: 'MNT' });
      expect(r.totals).toEqual({ disbursedAmount: 2650000, paidPrincipal: 140000, outstandingPrincipal: 2510000, outstandingInterest: 90000 });
      expect(col(await getReport(env, admin, 'outstanding-balance', { status: 'MIGRATED' }), 'contractNo')).toEqual(['B10026LD']);
    });
  });

  describe('closed-loans', () => {
    it('CLOSED зээл: сүүлийн төлбөрийн өдөр (UB) эсвэл updatedAt; хүү/үндсэн/нийт', async () => {
      const r = await getReport(env, admin, 'closed-loans');
      expect(col(r, 'contractNo')).toEqual(['B10026LF', 'B10026CL2']);
      expect(r.rows[0]).toMatchObject({ customerName: 'Оюун Цэцэг', registerNo: 'УБ****0006', productName: 'Хэрэглээний зээл', disbursedAmount: 400000, termMonths: 4, interestRate: 0.24, disbursedDate: '2026-05-20', closedDate: '2026-09-20', paymentCount: 2, interestPaid: 40000, principalPaid: 400000, totalPaid: 440000 });
      expect(r.rows[1]).toMatchObject({ disbursedAmount: 100000, disbursedDate: null, closedDate: '2026-08-15', paymentCount: 0, interestPaid: 0, principalPaid: 0, totalPaid: 0 });
      expect(r.totals).toEqual({ disbursedAmount: 500000, paymentCount: 2, interestPaid: 40000, principalPaid: 400000, totalPaid: 440000 });
    });

    it('dateFrom/dateTo нь хаагдсан огноонд', async () => {
      expect(col(await getReport(env, admin, 'closed-loans', { dateFrom: '2026-09-01' }), 'contractNo')).toEqual(['B10026LF']);
      expect(col(await getReport(env, admin, 'closed-loans', { dateTo: '2026-08-31' }), 'contractNo')).toEqual(['B10026CL2']);
      expect(col(await getReport(env, admin, 'closed-loans', { dateFrom: '2026-09-20', dateTo: '2026-09-20' }), 'contractNo')).toEqual(['B10026LF']);
      expect((await getReport(env, admin, 'closed-loans', { dateFrom: '2026-10-01' })).total).toBe(0);
    });
  });

  describe('disbursed-loans', () => {
    it('APPROVED/SENT_TO_CORE олголтууд (DRAFT/SUBMITTED орохгүй)', async () => {
      const r = await getReport(env, admin, 'disbursed-loans');
      expect(col(r, 'contractNo')).toEqual(['B10026LN', 'B10026LB', 'B10026LA', 'B10026LC', 'B10026LF']);
      expect(col(r, 'disburseDate')).toEqual(['2026-10-12', '2026-09-28', '2026-07-05', '2026-06-01', '2026-05-20']);
      expect(r.rows[2]).toMatchObject({ customerName: 'Бат Болд', productName: 'Хэрэглээний зээл', approvedAmount: 650000, disburseAmount: 600000, interestRate: 0.24, termMonths: 6, repaymentType: 'ANNUITY', coreLoanId: 'CORE-LA', status: 'SENT_TO_CORE' });
      expect(r.rows[0]).toMatchObject({ status: 'APPROVED', coreLoanId: null });
      expect(r.rows[3]).toMatchObject({ repaymentType: 'EQUAL_PRINCIPAL', interestRate: 0.36 });
      expect(r.totals).toEqual({ approvedAmount: 2600000, disburseAmount: 2550000 });
    });

    it('огноо ба төлөвөөр шүүх', async () => {
      expect(col(await getReport(env, admin, 'disbursed-loans', { dateFrom: '2026-09-01', dateTo: '2026-10-31' }), 'contractNo')).toEqual(['B10026LN', 'B10026LB']);
      expect(col(await getReport(env, admin, 'disbursed-loans', { dateFrom: '2026-09-28', dateTo: '2026-09-28' }), 'contractNo')).toEqual(['B10026LB']);
      expect(col(await getReport(env, admin, 'disbursed-loans', { status: 'APPROVED' }), 'contractNo')).toEqual(['B10026LN']);
      expect((await getReport(env, admin, 'disbursed-loans', { status: 'SENT_TO_CORE' })).total).toBe(4);
    });
  });

  describe('interest-payments', () => {
    it('зээл тутамд төлсөн хүү/үндсэн/хуваарилагдаагүй/нийт (allocation Σ); сүүлийн төлөлтөөр буурах', async () => {
      const r = await getReport(env, admin, 'interest-payments');
      expect(col(r, 'contractNo')).toEqual(['B10026LB', 'B10026LN', 'B10026LF', 'B10026LD', 'B10026LA']);
      expect(col(r, 'lastPaidDate')).toEqual(['2026-10-27', '2026-10-01', '2026-09-20', '2026-09-16', '2026-09-12']); // LN: UTC 09-30 17:30 = UB 10-01
      const byNo = Object.fromEntries(r.rows.map((x) => [x.contractNo as string, x]));
      expect(byNo.B10026LA).toMatchObject({ customerName: 'Бат Болд', providers: 'BANK_TRANSFER, QPAY', paymentCount: 2, interestPaid: 20000, principalPaid: 140000, unallocated: 0, totalPaid: 160000 });
      expect(byNo.B10026LB).toMatchObject({ paymentCount: 1, interestPaid: 5000, principalPaid: 0, unallocated: 0, totalPaid: 5000 });
      expect(byNo.B10026LF).toMatchObject({ paymentCount: 2, interestPaid: 40000, principalPaid: 400000, totalPaid: 440000, providers: 'BANK_TRANSFER, QPAY' });
      expect(byNo.B10026LN).toMatchObject({ paymentCount: 1, interestPaid: 0, principalPaid: 0, unallocated: 1000, totalPaid: 1000 });
      expect(byNo.B10026LD).toMatchObject({ currency: 'USD', providers: 'SOCIALPAY', interestPaid: 100, principalPaid: 1000, totalPaid: 1100 });
      // нийт = хүү + үндсэн + хуваарилагдаагүй
      for (const row of r.rows) expect(Number(row.totalPaid)).toBeCloseTo(Number(row.interestPaid) + Number(row.principalPaid) + Number(row.unallocated), 2);
    });

    it('currency=MNT нийлбэр', async () => {
      const r = await getReport(env, admin, 'interest-payments', { currency: 'MNT' });
      expect(r.totals).toEqual({ paymentCount: 6, interestPaid: 65000, principalPaid: 540000, unallocated: 1000, totalPaid: 606000 });
    });

    it('огноо (UB өдөр) ба провайдераар шүүх', async () => {
      expect(col(await getReport(env, admin, 'interest-payments', { dateFrom: '2026-10-01' }), 'contractNo')).toEqual(['B10026LB', 'B10026LN']);
      expect(col(await getReport(env, admin, 'interest-payments', { dateTo: '2026-09-30' }), 'contractNo')).toEqual(['B10026LF', 'B10026LD', 'B10026LA']);
      const qpay = await getReport(env, admin, 'interest-payments', { provider: 'QPAY' });
      expect(col(qpay, 'contractNo').sort()).toEqual(['B10026LA', 'B10026LF']);
      const la = qpay.rows.find((x) => x.contractNo === 'B10026LA');
      expect(la).toMatchObject({ paymentCount: 1, interestPaid: 10000, principalPaid: 100000, totalPaid: 110000, providers: 'QPAY' });
      expect(col(await getReport(env, admin, 'interest-payments', { provider: 'SOCIALPAY' }), 'contractNo')).toEqual(['B10026LD']);
      expect((await getReport(env, admin, 'interest-payments', { dateFrom: '2026-09-12', dateTo: '2026-09-12', provider: 'BANK_TRANSFER' })).total).toBe(1);
    });
  });

  describe('collateral-assets', () => {
    it('барьцаа бүр: өмчлөгч, үнэ, LTV, ЭБ, статус (30 хоногт дуусах = EXPIRING)', async () => {
      const r = await getReport(env, admin, 'collateral-assets');
      expect(r.total).toBe(4);
      expect(col(r, 'status')).toEqual(['RELEASED', 'EXPIRING', 'EXPIRED', 'OK']); // insuranceExpiresAt өсөх: 11-05, 11-10, 2027-03-01, null
      const [c4, c1, c2, c3] = r.rows;
      expect(c1).toMatchObject({ contractNo: 'B10026LA', applicationStatus: 'ACTIVE', customerName: 'Бат Болд', registerNo: 'УБ****0001', ownerName: 'Бат Болд', kind: 'MOVABLE', assetType: 'VEHICLE', description: '1234УБА Toyota Prius 2018', marketValue: 1000000, haircutRate: 0.7, collateralValue: 700000, ltv: 0.6, encumbranceStatus: 'CLEAR', registryNo: 'ЭБ-001', registryDate: '2025-01-15', insuranceExpiresAt: '2026-11-10', nextRevaluationAt: '2027-06-01', releasedDate: null, currency: 'MNT' });
      expect(c2).toMatchObject({ ownerName: 'Гомбо Туяа', kind: 'IMMOVABLE', assetType: 'APARTMENT', description: 'БЗД, 3-р хороо 54 м² 5-р давхар', ltv: 0.6, encumbranceStatus: 'ENCUMBERED', insuranceExpiresAt: '2027-03-01', nextRevaluationAt: '2026-10-01' });
      expect(c3).toMatchObject({ ownerName: 'Дорж Сараа', assetType: 'LIVESTOCK', description: 'Үхэр 20 толгой', collateralValue: 200000, ltv: 1.5, insuranceExpiresAt: null, nextRevaluationAt: null });
      expect(c4).toMatchObject({ contractNo: 'B10026LC', ltv: null, releasedDate: '2026-10-01', insuranceExpiresAt: '2026-11-05', collateralValue: 1600000 });
      expect(r.totals).toEqual({ marketValue: 3900000, collateralValue: 2800000 });
    });

    it('төлөв, хөрөнгийн төрлөөр шүүх; asOf шилжихэд EXPIRING → EXPIRED', async () => {
      expect(col(await getReport(env, admin, 'collateral-assets', { status: 'EXPIRING' }), 'registryNo')).toEqual(['ЭБ-001']);
      expect((await getReport(env, admin, 'collateral-assets', { status: 'EXPIRED' })).rows[0]).toMatchObject({ ownerName: 'Гомбо Туяа' });
      expect((await getReport(env, admin, 'collateral-assets', { status: 'OK' })).total).toBe(1);
      expect(col(await getReport(env, admin, 'collateral-assets', { assetType: 'APARTMENT' }), 'status')).toEqual(['RELEASED', 'EXPIRED']);
      expect((await getReport(env, admin, 'collateral-assets', { assetType: 'APARTMENT', status: 'RELEASED' })).total).toBe(1);
      const later = await getReport(env, admin, 'collateral-assets', { asOf: '2026-11-11', assetType: 'VEHICLE' });
      expect(later.rows[0]).toMatchObject({ status: 'EXPIRED' }); // 11-10 өнгөрсөн
    });

    it('30 хоногийн хил: asOf+30 өдөр орно, +31 орохгүй', async () => {
      // c1 insurance = 2026-11-10 → asOf=2026-10-11 дээр asOf+30 = 11-10 (орно), asOf=2026-10-10 дээр 11-09 (орохгүй)
      expect((await getReport(env, admin, 'collateral-assets', { asOf: '2026-10-11', assetType: 'VEHICLE' })).rows[0]).toMatchObject({ status: 'EXPIRING' });
      expect((await getReport(env, admin, 'collateral-assets', { asOf: '2026-10-10', assetType: 'VEHICLE' })).rows[0]).toMatchObject({ status: 'OK' });
    });
  });

  describe('pipeline-progress', () => {
    it('DRAFT…ACTIVE хүсэлт: одоогийн алхам, төлөвт хэдэн хоног, бүрдэлт X/12', async () => {
      const r = await getReport(env, admin, 'pipeline-progress');
      expect(r.total).toBe(10);
      expect(col(r, 'daysInStatus').slice(0, 2)).toEqual([18, 10]); // LI, LG
      expect(col(r, 'daysInStatus').slice(-2)).toEqual([2, 1]); // LH, LK
      const byApp = Object.fromEntries(r.rows.map((x) => [x.appNo as string, x]));
      expect(byApp['APP-LG']).toMatchObject({ customerName: 'Лхагва Мөнх', registerNo: 'УБ****0008', productName: 'Хэрэглээний зээл', amount: 2000000, status: 'DRAFT', currentStep: 'inquiry', currentStepStatus: 'PENDING', daysInStatus: 10, progress: '1/12', createdDate: '2026-10-15', contractNo: null });
      expect(byApp['APP-LH']).toMatchObject({ status: 'SUBMITTED', currentStep: 'score', currentStepStatus: 'STALE', progress: '6/12', daysInStatus: 2 });
      expect(byApp['APP-LI']).toMatchObject({ status: 'RETURNED', currentStep: null, currentStepStatus: null, progress: '9/12', daysInStatus: 18 });
      expect(byApp['APP-LJ']).toMatchObject({ status: 'APPROVED', currentStep: 'contract', currentStepStatus: 'PENDING', progress: '9/12', daysInStatus: 8 });
      expect(byApp['APP-LK']).toMatchObject({ status: 'DISBURSING', currentStep: 'disburse', progress: '11/12', daysInStatus: 1 });
      expect(byApp['APP-LA']).toMatchObject({ status: 'ACTIVE', currentStep: null, progress: '12/12', daysInStatus: 8, contractNo: 'B10026LA' });
      expect(Object.keys(byApp)).not.toContain('APP-LD'); // MIGRATED
      expect(Object.keys(byApp)).not.toContain('APP-LF'); // CLOSED
      expect(r.totals).toEqual({ amount: 10650000 });
    });

    it('төлөв, үүссэн огноогоор шүүх (CLOSED/MIGRATED зөвхөн status шүүлтээр)', async () => {
      expect(col(await getReport(env, admin, 'pipeline-progress', { status: 'MIGRATED' }), 'appNo')).toEqual(['APP-LD']);
      expect((await getReport(env, admin, 'pipeline-progress', { status: 'CLOSED' })).total).toBe(2);
      expect(col(await getReport(env, admin, 'pipeline-progress', { status: 'DRAFT' }), 'appNo')).toEqual(['APP-LG']);
      expect(col(await getReport(env, admin, 'pipeline-progress', { dateFrom: '2026-10-01' }), 'appNo')).toEqual(['APP-LG']);
      expect((await getReport(env, admin, 'pipeline-progress', { dateTo: '2026-09-30' })).total).toBe(9);
      expect(col(await getReport(env, admin, 'pipeline-progress', { sortBy: 'progress', sortDir: 'asc' }), 'progress')[0]).toBe('1/12');
    });
  });

  describe('deposit-balances (core-mock)', () => {
    it('ACTIVE/MIGRATED зээлийн үндсэн/хамтран зээлдэгчийн дансууд; регистр, данс нуугдмал; Core mock deterministic', async () => {
      const a = await getReport(env, admin, 'deposit-balances', { pageSize: 100 });
      // ACTIVE/MIGRATED: LA, LB, LC, LD, LE, LN (регистр 90000001…05, 13)
      const holders: Array<[string, string]> = [[w.LA.customer.id, 'УБ90000001'], [w.LB.customer.id, 'УБ90000002'], [w.LC.customer.id, 'УБ90000003'], [w.LD.customer.id, 'УБ90000004'], [w.LE.customer.id, 'УБ90000005'], [w.LN.customer.id, 'УБ90000013']];
      const expected = holders.flatMap(([id, reg]) => accountsFor(id, reg));
      expect(a.total).toBe(expected.length);
      expect(a.rows).toHaveLength(expected.length);
      for (const row of a.rows) {
        expect(String(row.registerNo)).toMatch(/^УБ\*{4}\d{4}$/);
        expect(String(row.accountNo)).toMatch(/^\*+\d{4}$/);
        expect(row.accountNo).not.toBe('');
      }
      const b = await getReport(env, admin, 'deposit-balances', { pageSize: 100 });
      expect(b.rows).toEqual(a.rows); // deterministic
      expect(a.mixedCurrency).toBe(true); // MNT + USD данс
      expect(a.totals).toBeUndefined();
      const mnt = await getReport(env, admin, 'deposit-balances', { currency: 'MNT', pageSize: 100 });
      expect(mnt.total).toBe(6);
      const sum = expected.filter((x) => x.currency === 'MNT').reduce((s, x) => s + x.balance, 0);
      expect(mnt.totals?.balance).toBeCloseTo(sum, 2);
      expect(col(mnt, 'balance')).toEqual([...col(mnt, 'balance')].sort((x, y) => Number(y) - Number(x))); // анхдагч: үлдэгдэл буурах
    });
  });
});
