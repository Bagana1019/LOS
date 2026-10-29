// NFR / CLAUDE.md §6.5: PII (нэр, регистр, дансны дугаар, гүйлгээний утга, файлын нэр, OCR текст) хадгалагдсан issue / түүх / event / лог-д ХЭЗЭЭ Ч орохгүй.
// Олон замыг нэг дор гүйцэтгэж (амжилт, баталгаажуулалтын алдаа, буруу нэр, үл мэдэгдэх банк, дэд бүтцийн алдаа, reclassify, дүрэм, finalize,
// retention) үлдсэн БҮХ хадгалалтыг хуурамч PII тэмдгээр шүүнэ.
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObjectStore } from '../common/infra.ports';
import { createHarness, ADMIN, OFFICER, type Harness } from './testing/harness';
import {
  ACCOUNT_A, ACCOUNT_B, HOLDER, OPENING_B, PII_MARKERS, accountBTxns, happyFiles, withoutRandomIds,
} from './testing/scenario';
import { buildStatementFile } from './testing/statement-files';
import { alterBalanceOfRow } from './testing/tamper';

const EXTRA_MARKERS = ['Zorigt', '99112233', 'Тест Харилцагч', 'secret-surname', 'minio down', 'redis down', 'socket hang up'];
const ALL_MARKERS = [...PII_MARKERS, ...EXTRA_MARKERS];

function leaks(label: string, value: unknown): string[] {
  const text = withoutRandomIds(typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).toLowerCase();
  return ALL_MARKERS.filter((m) => text.includes(m.toLowerCase())).map((m) => `${label}: ${m}`);
}

const logged: string[] = [];
function captureLogs(): void {
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  logged.length = 0;
});

/** Хадгалагдсан бүх ImportIssue (errors/warnings), түүх, domain event, хураангуй */
async function stored(h: Harness, ids: string[]): Promise<Array<[string, unknown]>> {
  const out: Array<[string, unknown]> = [];
  for (const id of ids) {
    const analysis = await h.memory.analyses.getById(id);
    out.push([`summary(${id})`, analysis?.summary]);
    out.push([`jobs(${id})`, (await h.memory.importJobs.list({ analysisId: id })).items.map((j) => ({ errors: j.errors, warnings: j.warnings, bank: j.bankCode, status: j.status }))]);
    out.push([`history(${id})`, (await h.memory.events.list(id)).items.map((e) => ({ action: e.action, actor: e.actorId, detail: e.detail }))]);
  }
  out.push(['domain events', h.publisher.events]);
  out.push(['queue log', h.queueLog]);
  out.push(['app log', logged]);
  return out;
}

describe('no PII in stored issues, history, events or logs', () => {
  it('holds across success, failure, infrastructure error and administration paths', async () => {
    captureLogs();
    const fail = { put: false, get: false, del: false };
    const h = await createHarness({
      attempts: 2,
      wrapStore: (inner): ObjectStore => ({
        put: async (k, b, c) => {
          if (fail.put) throw new Error('minio down while writing zxq-secret 5011223344');
          return inner.put(k, b, c);
        },
        get: async (k) => {
          if (fail.get) throw new Error(`socket hang up reading ${HOLDER} ${ACCOUNT_A}`);
          return inner.get(k);
        },
        exists: (k) => inner.exists(k),
        delete: async (k) => {
          if (fail.del) throw new Error('minio down while deleting zxq-secret');
          return inner.delete(k);
        },
      }),
    });
    const ids: string[] = [];

    // 1) Амжилттай импорт + гар ангилал + дүрэм + finalize
    const ok = await h.createAnalysis({
      customer: {
        registerNo: 'УБ90010203', lastName: 'Bat-Erdene', firstName: 'Bold', phone: '99112233',
        declaredAccounts: [{ bankCode: 'TDB', accountNo: ACCOUNT_A, holderName: HOLDER }],
      },
    });
    ids.push(ok.id);
    const { a, b } = await happyFiles();
    await h.uploadFiles(ok.id, [a, b]);
    const rent = (await h.memory.transactions.loadAll(ok.id)).find((r) => r.description.startsWith('Түрээс'));
    expect(rent).toBeDefined();
    await h.reclassify.reclassify(OFFICER, ok.id, { transactionIds: [rent!.id], categoryCode: 'IRREGULAR_INCOME', applyToSimilar: true });
    await h.reclassify.createRule(ADMIN, { direction: 'EXPENSE', matchType: 'KEYWORD', pattern: 'zxq-secret', categoryCode: 'OTHER_EXPENSE', priority: 90_000 }, { analysisId: ok.id });
    await h.analysis.updateParams(OFFICER, ok.id, { proposedMonthlyPayment: 650_000 });
    await h.finalize.finalize(OFFICER, ok.id);

    // 2) Баталгаажуулалтын алдаа (үлдэгдэл), өөр хүний хуулга, үл мэдэгдэх банк
    const bad = await h.createAnalysis({ loanApplicationId: 'app-bad' });
    ids.push(bad.id);
    const tampered = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'zxq-secret-tampered.csv', tamper: alterBalanceOfRow(3),
    });
    const stranger = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B + 5, accountNo: ACCOUNT_B, iban: null, holder: 'Zorigt Dorj', fileName: 'zxq-secret-stranger.csv',
    });
    const unknown = { content: Buffer.from(`Date,Item\n2026-04-01,ZXQ-secret ${HOLDER} ${ACCOUNT_A}\n`, 'utf8'), fileName: 'zxq-secret-unknown.csv', mimeType: 'text/csv' };
    await h.uploadFiles(bad.id, [tampered, stranger]);
    await h.upload.upload(OFFICER, bad.id, [unknown]);

    // 3) Дэд бүтцийн алдаа: дараалал унасан, хадгалалт унасан, уншилт эцсийн оролдлого хүртэл унасан
    const queued = await h.createAnalysis({ loanApplicationId: 'app-queue' });
    ids.push(queued.id);
    const queueSpy = vi.spyOn(h.queue, 'enqueue').mockRejectedValueOnce(new Error('redis down zxq-secret Bat-Erdene'));
    await h.uploadFiles(queued.id, [a]);
    queueSpy.mockRestore();

    const stored2 = await h.createAnalysis({ loanApplicationId: 'app-store' });
    ids.push(stored2.id);
    fail.put = true;
    await h.uploadFiles(stored2.id, [b]); // put амжилтгүй ⇒ STORAGE_FAILED
    fail.put = false;

    const reading = await h.createAnalysis({ loanApplicationId: 'app-read' });
    ids.push(reading.id);
    fail.get = true; // уншилт бүр унана ⇒ эцсийн оролдлогод INTERNAL_ERROR
    await h.uploadFiles(reading.id, [a]);
    fail.get = false;
    expect((await h.jobs(reading.id))[0].errors.map((e) => e.code)).toEqual(['INTERNAL_ERROR']);

    // Хадгалалтыг УСТГАЛТААС ӨМНӨ шалгана (retention бүх мөрийг устгана)
    const before = (await stored(h, ids)).flatMap(([label, value]) => leaks(label, value));
    expect(before).toEqual([]);

    // 4) Устгал: DB-ийн дараа файл устгах алдаатай (лог + domain event)
    h.clock.advance(5 * 365 * 24 * 3600 * 1000);
    fail.del = true;
    const report = await h.retention.purgeExpired();
    fail.del = false;
    expect(report.purged).toBe(ids.length);
    expect(report.objectFailures).toBeGreaterThan(0);

    const after = [...leaks('app log', logged), ...leaks('queue log', h.queueLog), ...leaks('domain events', h.publisher.events)];
    expect(after).toEqual([]);

    // Шалгалт өөрөө утга учиртай эсэх: логт ямар нэг зүйл бичигдсэн, тэмдэг нь жинхэнэ PII-тэй таарна
    expect(logged.length + h.queueLog.length).toBeGreaterThan(0);
    expect(leaks('probe', `${HOLDER} ${ACCOUNT_A}`).length).toBeGreaterThan(0);
  });

  it('a suggested rule built from a person-like description is returned to the caller but never stored or logged', async () => {
    captureLogs();
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const extra = ['04', '05', '06'].map((m) => ({
      date: `2026-${m}-25`, time: '15:00:00', direction: 'INCOME' as const, amount: 100_000, description: `Zorigt Dorj Transfer ZXQ-N${m}`,
    }));
    const txns = [...accountBTxns(), ...extra].sort((x, y) => `${x.date} ${x.time}`.localeCompare(`${y.date} ${y.time}`));
    const file = await buildStatementFile({ bank: 'MBANK', txns, opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'zxq-secret-b.csv' });
    await h.uploadFiles(analysis.id, [file]);
    const row = (await h.memory.transactions.loadAll(analysis.id)).find((r) => r.description.startsWith('Zorigt'));
    expect(row).toBeDefined();

    const res = await h.reclassify.reclassify(OFFICER, analysis.id, { transactionIds: [row!.id], categoryCode: 'IRREGULAR_INCOME', applyToSimilar: true });
    expect(res.similar).toBe(2);
    // Санал болгосон хэв гүйлгээний утгаас гарсан ⇒ дуудагчид буцна (ADMIN хянана), гэхдээ хадгалагдахгүй
    expect(JSON.stringify(res.suggestedRule).toLowerCase()).toContain('zorigt');
    expect(leaks('rule library', await h.reclassify.listRules(ADMIN))).toEqual([]);
    expect(leaks('history', (await h.analysis.listEvents(OFFICER, analysis.id)).items)).toEqual([]);
    expect(leaks('logs', [...logged, ...h.queueLog])).toEqual([]);
    // Хэрэглэгчийн харагдацад (view) гүйлгээний утга байгаа нь зөв (өөрийн өгөгдөл): энэ нь хадгалалтын шалгалт биш
    expect((await h.analysis.listTransactions(OFFICER, analysis.id)).items.some((t) => t.description.startsWith('Zorigt'))).toBe(true);
  });

  it('the fixed Mongolian messages never echo a parsed value', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const tampered = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'x.csv', tamper: alterBalanceOfRow(2),
    });
    await h.uploadFiles(analysis.id, [tampered]);
    const [job] = await h.jobs(analysis.id);
    expect(job.errors.length).toBeGreaterThan(0);
    for (const e of job.errors) {
      // Мессеж = тогтмол текст (+ эгнээний дугаар): дүн, нэр, дансны дугаар байхгүй
      expect(e.message).not.toMatch(/\d{5,}/);
      expect(leaks('message', e.message)).toEqual([]);
    }
  });
});
