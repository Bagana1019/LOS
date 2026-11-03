// BSA-FR-4.7 / INT-9: PDF тайлан (DTI тойм, орлого/зарлагын задаргаа, сэжигтэй дохио) ба «Орлогын түүвэр» Excel.
// Кирилл фонт: DejaVu Sans (dms-ийн esign-тэй ижил). Тайланд дансны дугаар ИЛ гарахгүй (далдалсан), регистр огт орохгүй.
import { Inject, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import type { BsaAnalysisDetails } from '@los/contracts';
import { BSA_REPOSITORY, type BsaRepository } from '../common/persistence';
import type { RequestContext } from '../common/infra.ports';
import { loadAnalysis } from '../import/access';
import { unprocessable } from '../import/import.errors';
import { RecalculationService } from '../import/recalculation.service';
import { toTransactionView } from '../import/views';
import { buildCounts } from '../suspicion/suspicion-review.service';

const FONT_REGULAR = 'dejavu-fonts-ttf/ttf/DejaVuSans.ttf';
const FONT_BOLD = 'dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf';
const fontCache = new Map<string, Promise<Uint8Array>>();
const loadFont = (mod: string): Promise<Uint8Array> => {
  let p = fontCache.get(mod);
  if (!p) {
    p = readFile(require.resolve(mod));
    fontCache.set(mod, p);
    p.catch(() => fontCache.delete(mod));
  }
  return p;
};

const FLAG_LABEL: Record<string, string> = {
  OWN_ACCOUNT: 'Өөрийн данс руу шилжүүлэг', CIRCULAR: 'Тойрог шилжүүлэг', INTER_ACCOUNT_FRAUD: 'Данс хоорондын залилан', QUICK_CASH: 'Хурдан бэлэн авалт',
  SPLIT_WITHDRAWAL: 'Хуваан авалт', COLLUSION: 'Хамтарсан залилан', STRUCTURING: 'Бүтэцлэгдсэн төлбөр', GAMBLING: 'Мөрийтэй тоглоом',
};
const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 0 });

export interface ReportFile {
  fileName: string;
  contentType: string;
  bytes: Buffer;
}

@Injectable()
export class ReportService {
  constructor(
    @Inject(BSA_REPOSITORY) private readonly repo: BsaRepository,
    @Inject(RecalculationService) private readonly recalc: RecalculationService,
  ) {}

  /** PDF тайлан (унших эрх хангалттай) */
  async pdf(ctx: RequestContext, analysisId: string): Promise<ReportFile> {
    const analysis = await loadAnalysis(this.repo, ctx, analysisId, 'read');
    const { summary, details } = await this.recalc.report(ctx, analysisId);
    if (!summary || !details) throw unprocessable('REPORT_NOT_AVAILABLE');
    const counts = buildCounts(await this.repo.suspicions.counts(analysisId));

    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(await loadFont(FONT_REGULAR), { subset: true });
    const bold = await doc.embedFont(await loadFont(FONT_BOLD), { subset: true });
    doc.setTitle('Дансны хуулгын шинжилгээ');
    doc.setProducer('LOS Radix · BSA');
    const w = new PageWriter(doc, font, bold);

    w.title('Дансны хуулгын шинжилгээ (BSA)');
    w.line(`Хүсэлт: ${analysis.applicationId}   Хувилбар: v${analysis.version}   Төлөв: ${analysis.status === 'ANALYZED' ? 'Шинжилсэн' : 'Ноорог'}`);
    w.line(`Хугацаа: ${details.period.from} — ${details.period.to} (${details.period.months} сар)   Гүйлгээ: ${summary.transactionCount}`);
    w.gap();
    w.heading('DTI тойм');
    w.row('Нийт сарын орлого', fmt(summary.totalMonthlyIncome));
    w.row('Баталгаажсан сарын орлого', fmt(summary.verifiedMonthlyIncome));
    w.row('DTI орлого (ББӨ хасаад)', fmt(summary.dtiIncome));
    w.row('Одоогийн зээлийн сарын төлбөр', fmt(summary.existingDebtServiceMonthly));
    w.row('Санал болгосон сарын төлбөр', fmt(details.dti.proposedMonthlyPayment));
    w.row('DTI (ӨОХ)', `${summary.dtiPercent}% — ${{ LOW: 'Бага', MEDIUM: 'Дунд', HIGH: 'Өндөр' }[summary.dtiLevel]} (хязгаар ${Math.round(details.dti.maxDti * 100)}%)`);
    w.row('Орлогын найдвар', `${summary.incomeReliability}%`);
    w.row('Бизнесийн цэвэр мөнгөн урсгал (сарын)', fmt(summary.netCashFlowMonthly));
    w.gap();
    w.heading('Тооцооллын аргачлал');
    for (const m of details.methodology) w.line(`${m.step}. ${m.label}: ${m.formula} = ${fmt(m.value)}`, 9);
    w.gap();
    for (const dir of ['INCOME', 'EXPENSE'] as const) {
      w.heading(dir === 'INCOME' ? 'Орлогын задаргаа (сарын дундаж)' : 'Зарлагын задаргаа (сарын дундаж)');
      for (const c of details.categories.filter((x: BsaAnalysisDetails['categories'][number]) => x.direction === dir && x.totalAmount > 0)) {
        w.row(`${c.name} (${c.txnCount})`, `${fmt(c.monthlyAvg)}  ·  ${Math.round(c.share * 100)}%`);
      }
      w.gap();
    }
    w.heading('Сэжигтэй гүйлгээ');
    w.row('Нийт / хүлээгдэж буй / шийдвэрлэсэн', `${counts.total} / ${counts.pending} / ${counts.resolved}`);
    for (const [flag, c] of Object.entries(counts.byFlag)) if (c.total > 0) w.row(FLAG_LABEL[flag] ?? flag, `${c.total} (хүлээгдэж буй ${c.pending})`);
    if (details.warnings.length > 0) {
      w.gap();
      w.heading('Анхааруулга');
      for (const x of details.warnings) w.line(`• ${x.message}`, 9);
    }
    return { fileName: `bsa-${analysis.applicationId}-v${analysis.version}.pdf`, contentType: 'application/pdf', bytes: Buffer.from(await doc.save()) };
  }

  /** «Орлогын түүвэр» (Excel): хугацаанд орсон орлогын гүйлгээнүүд (өөрийн дансны шилжүүлгээс бусад). Дансны дугаар далдалсан */
  async incomeSample(ctx: RequestContext, analysisId: string): Promise<ReportFile> {
    const analysis = await loadAnalysis(this.repo, ctx, analysisId, 'read');
    const { details } = await this.recalc.report(ctx, analysisId);
    if (!details) throw unprocessable('REPORT_NOT_AVAILABLE');
    const [txns, cats] = await Promise.all([this.repo.transactions.loadAll(analysisId), this.repo.config.listCategories(analysis.orgId)]);
    const name = new Map(cats.map((c) => [c.code, c.name]));
    const rows = txns.filter((t) => t.direction === 'INCOME' && !t.isOwnTransfer && t.txnDate >= details.period.from && t.txnDate <= details.period.to).map(toTransactionView);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Орлогын түүвэр');
    ws.columns = [
      { header: 'Огноо', key: 'date', width: 12 }, { header: 'Цаг', key: 'time', width: 9 }, { header: 'Дүн', key: 'amount', width: 16 },
      { header: 'Гүйлгээний утга', key: 'desc', width: 48 }, { header: 'Харьцсан данс', key: 'acc', width: 18 }, { header: 'Ангилал', key: 'cat', width: 28 }, { header: 'Суваг', key: 'ch', width: 10 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const t of rows) ws.addRow({ date: t.txnDate, time: t.txnTime ?? '', amount: t.amount, desc: t.description, acc: t.counterpartyAccount ?? '', cat: name.get(t.categoryCode ?? '') ?? t.categoryCode ?? '', ch: t.channel });
    ws.getColumn('amount').numFmt = '#,##0.00';
    return {
      fileName: `bsa-income-${analysis.applicationId}-v${analysis.version}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: Buffer.from(await wb.xlsx.writeBuffer()),
    };
  }
}

/** A4, босоо урсгалтай бичигч — хуудас дүүрэхэд шинэ хуудас нээнэ */
class PageWriter {
  private page: PDFPage;
  private y = 0;
  private static readonly W = 595.28;
  private static readonly H = 841.89;
  private static readonly M = 40;

  constructor(private readonly doc: PDFDocument, private readonly font: PDFFont, private readonly bold: PDFFont) {
    this.page = this.addPage();
  }

  private addPage(): PDFPage {
    const p = this.doc.addPage([PageWriter.W, PageWriter.H]);
    this.y = PageWriter.H - PageWriter.M;
    return p;
  }

  private ensure(h: number): void {
    if (this.y - h < PageWriter.M) this.page = this.addPage();
  }

  title(t: string): void {
    this.ensure(30);
    this.page.drawText(t, { x: PageWriter.M, y: this.y - 18, size: 18, font: this.bold, color: rgb(0.1, 0.1, 0.1) });
    this.y -= 30;
  }

  heading(t: string): void {
    this.ensure(22);
    this.page.drawText(t, { x: PageWriter.M, y: this.y - 12, size: 12, font: this.bold, color: rgb(0.1, 0.25, 0.5) });
    this.y -= 20;
  }

  line(t: string, size = 10): void {
    for (const part of this.wrap(t, size, PageWriter.W - 2 * PageWriter.M)) {
      this.ensure(size + 4);
      this.page.drawText(part, { x: PageWriter.M, y: this.y - size, size, font: this.font });
      this.y -= size + 4;
    }
  }

  row(label: string, value: string): void {
    this.ensure(15);
    this.page.drawText(label, { x: PageWriter.M, y: this.y - 10, size: 10, font: this.font });
    const vw = this.bold.widthOfTextAtSize(value, 10);
    this.page.drawText(value, { x: PageWriter.W - PageWriter.M - vw, y: this.y - 10, size: 10, font: this.bold });
    this.y -= 15;
  }

  gap(): void {
    this.y -= 8;
  }

  private wrap(text: string, size: number, maxWidth: number): string[] {
    const out: string[] = [];
    let cur = '';
    for (const word of text.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (this.font.widthOfTextAtSize(next, size) > maxWidth && cur) {
        out.push(cur);
        cur = word;
      } else cur = next;
    }
    if (cur) out.push(cur);
    return out;
  }
}
