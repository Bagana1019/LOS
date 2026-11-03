// BSA-FR-4.7 (PDF/Excel) ба BSA-BR-9 (хамтран зээлдэгчийн нэгтгэл). SYNTHETIC өгөгдөл.
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { CombinedService } from '../combined/combined.service';
import { createHarness, ctxOf, OFFICER, type Harness } from '../import/testing/harness';
import { ReportService } from './report.service';

async function seed(h: Harness, customerId: string, rows: Array<{ txnDate: string; direction: 'INCOME' | 'EXPENSE'; amount: number; description: string }>, over: Record<string, unknown> = {}): Promise<string> {
  const analysis = await h.createAnalysis({ customerId, borrowerId: `bor-${customerId}`, periodMonths: 3, ...over });
  const job = await h.memory.importJobs.create({ analysisId: analysis.id, fileId: `f-${customerId}`, fileName: 'x.csv', mimeType: 'text/csv', sizeBytes: 1, sha256: 'b'.repeat(64), format: 'CSV' });
  await h.memory.importJobs.update(job.id, { status: 'COMPLETED', bankCode: 'TDB', periodFrom: '2026-04-01', periodTo: '2026-06-30', rowsTotal: rows.length, rowsDone: rows.length, accountNo: `50${customerId.length}1122334` });
  await h.memory.transactions.bulkInsert(job.id, rows.map((r, i) => ({ seq: i + 1, txnTime: '10:00:00', balanceAfter: null, counterpartyAccount: '5099887766', counterpartyName: null, statementKey: `s-${customerId}`, dedupeKey: `${customerId}-${i}`, ...r })));
  await h.recalc.recalculate(OFFICER, analysis.id);
  return analysis.id;
}
const salary = (amount: number) => ['04', '05', '06'].map((m) => ({ txnDate: `2026-${m}-05`, direction: 'INCOME' as const, amount, description: 'Цалин' }));

describe('ReportService', () => {
  it('PDF: хүчинтэй, кирилл фонттой; Excel: орлогын мөрүүд, дансны дугаар далдалсан', async () => {
    const h = await createHarness({ realSuspicion: true });
    const id = await seed(h, 'c1', [...salary(1_200_000), { txnDate: '2026-05-10', direction: 'EXPENSE', amount: 80_000, description: 'Казино' }]);
    const svc = new ReportService(h.repo, h.recalc);
    const pdf = await svc.pdf(OFFICER, id);
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(pdf.bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe('Дансны хуулгын шинжилгээ');

    const x = await svc.incomeSample(OFFICER, id);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.bytes as never);
    const ws = wb.worksheets[0]!;
    expect(ws.rowCount).toBe(4); // толгой + 3 цалин
    expect(String(ws.getRow(2).getCell(5).value)).not.toContain('5099');
    expect(x.fileName).toMatch(/\.xlsx$/);
  });

  it('гүйлгээгүй шинжилгээнд REPORT_NOT_AVAILABLE; өөр байгууллагад олдохгүй', async () => {
    const h = await createHarness();
    const a = await h.createAnalysis();
    const svc = new ReportService(h.repo, h.recalc);
    await expect(svc.pdf(OFFICER, a.id)).rejects.toMatchObject({ bsaCode: 'REPORT_NOT_AVAILABLE' });
    await expect(svc.incomeSample(OFFICER, a.id)).rejects.toMatchObject({ bsaCode: 'REPORT_NOT_AVAILABLE' });
    await expect(svc.pdf(ctxOf(['OFFICER'], { orgId: 'other' }), a.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('CombinedService (BSA-BR-9)', () => {
  it('хамтран зээлдэгч 2: DTI орлого Σ, өрийн үйлчилгээ Σ, санал болгосон төлбөр нэг л удаа', async () => {
    const h = await createHarness({ realSuspicion: true });
    const a1 = await seed(h, 'c1', salary(2_000_000));
    const a2 = await seed(h, 'c2', salary(1_000_000));
    const svc = new CombinedService(h.repo, { get: async () => h.settings });
    const c = await svc.forApplication(OFFICER, 'app-1');
    const s1 = (await h.analysis.get(OFFICER, a1)).summary!;
    const s2 = (await h.analysis.get(OFFICER, a2)).summary!;
    expect(c.analysisCount).toBe(2);
    expect(c.allAnalyzed).toBe(false); // ноорог
    expect(c.dtiIncome).toBeCloseTo(s1.dtiIncome + s2.dtiIncome, 2);
    expect(c.existingDebtServiceMonthly).toBeCloseTo(s1.existingDebtServiceMonthly + s2.existingDebtServiceMonthly, 2);
    const expected = Math.round(((500_000 + c.existingDebtServiceMonthly) / c.dtiIncome) * 1000) / 10;
    expect(c.dtiPercent).toBe(expected);
    expect(c.members.map((m) => m.analysisId).sort()).toEqual([a1, a2].sort());

    await h.finalize.finalize(OFFICER, a1);
    await h.finalize.finalize(OFFICER, a2);
    expect((await svc.forApplication(OFFICER, 'app-1')).allAnalyzed).toBe(true);
  });

  it('шинжилгээгүй хүсэлт → COMBINED_NOT_AVAILABLE (404)', async () => {
    const h = await createHarness();
    await expect(new CombinedService(h.repo, { get: async () => h.settings }).forApplication(OFFICER, 'app-x')).rejects.toMatchObject({ bsaCode: 'COMBINED_NOT_AVAILABLE', status: 404 });
  });
});
