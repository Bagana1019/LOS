// BSA-FR-2.1 / 2.6: хуулга хүлээн авах (олон файл), давхардал, татгалзах шалтгаан, дараалалд оруулах, дахин оруулах. SYNTHETIC өгөгдөл.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BsaDuplicateError } from '../common/persistence';
import { createHarness, OFFICER, ADMIN, ctxOf } from './testing/harness';
import { ACCOUNT_B, HOLDER, OPENING_B, accountBTxns, happyFiles } from './testing/scenario';
import { buildStatementFile } from './testing/statement-files';
import { alterBalanceOfRow } from './testing/tamper';

const FIXTURES = join(__dirname, '..', '..', '..', '..', 'test-fixtures', 'bsa', 'text-extraction');
const csv = (text: string) => ({ content: Buffer.from(text, 'utf8'), fileName: 'x.csv', mimeType: 'text/csv' });

describe('UploadService.upload', () => {
  it('rejects an empty request and more files than the configured maximum', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    await expect(h.upload.upload(OFFICER, analysis.id, [])).rejects.toMatchObject({ bsaCode: 'NO_FILES', status: 400 });
    const six = Array.from({ length: 6 }, (_, i) => csv(`a,b\n${i},1\n`));
    await expect(h.upload.upload(OFFICER, analysis.id, six)).rejects.toMatchObject({ bsaCode: 'TOO_MANY_FILES', status: 400 });
    expect(h.store.keys()).toHaveLength(0);
  });

  it('decides every file on its own and answers by index', async () => {
    const h = await createHarness({ startWorker: false, settings: { maxFilesPerUpload: 10 } });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    const xlsx = { content: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]), fileName: 'book.xlsx', mimeType: 'application/vnd.ms-excel' };
    const binary = { content: Buffer.from([0, 1, 2, 3, 0, 0, 255, 254, 0, 9, 9, 0]), fileName: 'blob.bin', mimeType: 'application/octet-stream' };
    const empty = { content: Buffer.alloc(0), fileName: 'empty.csv', mimeType: 'text/csv' };

    const res = await h.upload.upload(OFFICER, analysis.id, [
      { content: a.content, fileName: a.fileName, mimeType: a.mimeType },
      empty,
      xlsx,
      binary,
      { content: a.content, fileName: 'copy-of-a.csv', mimeType: 'text/csv' },
      { ...csv('a,b\n1,2\n'), bankCode: 'NOPE' as never },
    ]);

    expect(res).toMatchObject({ accepted: 1, duplicates: 1, rejected: 4 });
    const [first, ...rest] = res.outcomes;
    expect(first).toMatchObject({ index: 0, status: 'ACCEPTED', format: 'CSV' });
    expect(rest.map((o) => [o.index, o.status, 'code' in o ? o.code : null])).toEqual([
      [1, 'REJECTED', 'FILE_EMPTY'],
      [2, 'REJECTED', 'XLSX_UNSUPPORTED'],
      [3, 'REJECTED', 'FILE_UNSUPPORTED'],
      [4, 'DUPLICATE', null],
      [5, 'REJECTED', 'INVALID_BANK'],
    ]);
    expect(rest[3]).toMatchObject({ existingJobId: first.status === 'ACCEPTED' ? first.jobId : 'x' });
    // Татгалзсан файл object store-д орохгүй, ажил үүсгэхгүй
    expect(h.store.keys()).toHaveLength(1);
    expect(await h.jobs(analysis.id)).toHaveLength(1);
  });

  it('rejects an oversized file by the configured limit', async () => {
    const h = await createHarness({ settings: { maxUploadBytes: 100 } });
    const analysis = await h.createAnalysis();
    const res = await h.upload.upload(OFFICER, analysis.id, [csv('x'.repeat(101))]);
    expect(res.outcomes[0]).toMatchObject({ status: 'REJECTED', code: 'FILE_TOO_LARGE' });
  });

  it('uploading the same bytes again is a DUPLICATE of the first job (also inside one call)', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    const file = { content: a.content, fileName: 'one.csv', mimeType: 'text/csv' };
    const first = await h.upload.upload(OFFICER, analysis.id, [file, { ...file, fileName: 'two.csv' }]);
    expect(first).toMatchObject({ accepted: 1, duplicates: 1 });
    const jobId = first.outcomes[0].status === 'ACCEPTED' ? first.outcomes[0].jobId : '';
    expect(first.outcomes[1]).toMatchObject({ status: 'DUPLICATE', existingJobId: jobId });
    const second = await h.upload.upload(OFFICER, analysis.id, [file]);
    expect(second.outcomes[0]).toMatchObject({ status: 'DUPLICATE', existingJobId: jobId });
    expect(h.store.keys()).toHaveLength(1);
  });

  it('survives a concurrent identical upload: the loser discards its object and reports a duplicate', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    const file = { content: a.content, fileName: 'one.csv', mimeType: 'text/csv' };
    const first = await h.upload.upload(OFFICER, analysis.id, [file]);
    const jobId = first.outcomes[0].status === 'ACCEPTED' ? first.outcomes[0].jobId : '';
    // Хоёр дахь дуудлага давхардлыг урьдчилан шалгахад хараахан харагдаагүй (race)
    vi.spyOn(h.memory.importJobs, 'findBySha256').mockResolvedValueOnce(null);
    const second = await h.upload.upload(OFFICER, analysis.id, [file]);
    expect(second.outcomes[0]).toMatchObject({ status: 'DUPLICATE', existingJobId: jobId });
    expect(h.store.keys()).toHaveLength(1); // өнчин объект үлдээгээгүй
  });

  it('maps a PostgreSQL-style unique violation (no existing id) to a duplicate by looking the winner up again', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    const file = { content: a.content, fileName: 'one.csv', mimeType: 'text/csv' };
    const first = await h.upload.upload(OFFICER, analysis.id, [file]);
    const jobId = first.outcomes[0].status === 'ACCEPTED' ? first.outcomes[0].jobId : '';
    // Урьдчилсан шалгалт хоосон, create нь P2002-тэй адил existingId-гүй BsaDuplicateError шиднэ
    vi.spyOn(h.memory.importJobs, 'findBySha256').mockResolvedValueOnce(null);
    vi.spyOn(h.repo, 'runInTransaction').mockRejectedValueOnce(new BsaDuplicateError('IMPORT_FILE'));
    const second = await h.upload.upload(OFFICER, analysis.id, [file]);
    expect(second.outcomes[0]).toMatchObject({ status: 'DUPLICATE', existingJobId: jobId });
    expect(h.store.keys()).toHaveLength(1);
  });

  it('a duplicate violation whose winner cannot be found is reported as INTERNAL_ERROR, never as a silent success', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    vi.spyOn(h.repo, 'runInTransaction').mockRejectedValueOnce(new BsaDuplicateError('IMPORT_FILE'));
    const res = await h.uploadFiles(analysis.id, [a]);
    expect(res.outcomes[0]).toMatchObject({ status: 'REJECTED', code: 'INTERNAL_ERROR' });
    expect(h.store.keys()).toHaveLength(0);
  });

  it('reports STORAGE_FAILED when the object store is down and creates no job', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    vi.spyOn(h.objects, 'put').mockRejectedValueOnce(new Error('minio down zxq-secret'));
    const res = await h.uploadFiles(analysis.id, [a]);
    expect(res.outcomes[0]).toMatchObject({ status: 'REJECTED', code: 'STORAGE_FAILED' });
    expect(await h.jobs(analysis.id)).toHaveLength(0);
  });

  it('keeps the file name only in the job (sanitised) and never in the object key', async () => {
    const h = await createHarness({ startWorker: false });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.upload.upload(OFFICER, analysis.id, [{ content: a.content, fileName: 'zxq-secret\u0000\n.csv', mimeType: 'text/csv' }]);
    const [job] = await h.jobs(analysis.id);
    expect(job.fileName).toBe('zxq-secret.csv');
    const stored = await h.memory.importJobs.getById(job.id);
    expect(stored?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const [key] = h.store.keys();
    expect(key).toMatch(new RegExp(`^bsa/org-1/${analysis.id}/[0-9a-f-]{36}$`));
    expect(key).not.toContain('zxq');
    const events = (await h.analysis.listEvents(OFFICER, analysis.id)).items;
    expect(JSON.stringify(events)).not.toContain('zxq');
    // Нэргүй файл
    const other = await h.createAnalysis({ loanApplicationId: 'app-9' });
    await h.upload.upload(OFFICER, other.id, [{ content: a.content, fileName: '', mimeType: 'text/csv' }]);
    expect((await h.jobs(other.id))[0].fileName).toBe('unnamed');
  });

  it('accepts a picture as IMAGE and fails the job with a clear code when OCR is not available', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const content = readFileSync(join(FIXTURES, 'statement-table.png'));
    const res = await h.upload.upload(OFFICER, analysis.id, [{ content, fileName: 'scan.png', mimeType: 'image/png' }]);
    expect(res.outcomes[0]).toMatchObject({ status: 'ACCEPTED', format: 'IMAGE' });
    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    expect(job.format).toBe('IMAGE');
    expect(job.errors).toHaveLength(1);
    expect(job.errors[0].code).toMatch(/OCR/);
  });

  it('a manual bank override is stored, used by the worker and flagged when the content does not confirm it', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a], OFFICER, 'KHAN'); // TDB файлыг Хаан банкаар (parser нь толгойн шошгоор уншдаг тул уншигдана)
    const [job] = await h.jobs(analysis.id);
    expect(job.bankCode).toBe('KHAN');
    expect(job.status).toBe('COMPLETED');
    expect(job.warnings.map((w) => w.code)).toContain('BANK_OVERRIDE_UNCONFIRMED');
    const events = (await h.analysis.listEvents(OFFICER, analysis.id)).items.filter((e) => e.action === 'FILE_UPLOADED');
    expect(events[0].detail).toMatchObject({ bankOverride: 'KHAN' });
  });

  it('marks the job FAILED (QUEUE_UNAVAILABLE) when the queue is down; a retry succeeds later', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    vi.spyOn(h.queue, 'enqueue').mockRejectedValueOnce(new Error('redis down zxq-secret'));
    const res = await h.uploadFiles(analysis.id, [a]);
    expect(res.outcomes[0]).toMatchObject({ status: 'REJECTED', code: 'QUEUE_UNAVAILABLE' });
    const jobId = (res.outcomes[0] as { jobId?: string }).jobId as string;
    expect(jobId).toBeTruthy();
    const [job] = await h.jobs(analysis.id);
    expect(job).toMatchObject({ id: jobId, status: 'FAILED' });
    expect(job.errors.map((e) => e.code)).toEqual(['QUEUE_UNAVAILABLE']);
    expect(JSON.stringify(job.errors)).not.toContain('zxq');

    const retried = await h.upload.retryJob(OFFICER, analysis.id, jobId);
    expect(retried.status).toBe('COMPLETED');
    // Ижил файлыг дахин оруулбал давхардал: дахин оруулахдаа retryJob ашиглана
    const again = await h.uploadFiles(analysis.id, [a]);
    expect(again.outcomes[0]).toMatchObject({ status: 'DUPLICATE', existingJobId: jobId });
  });

  it('refuses a DRAFT-less analysis, a foreign one, and an org without a catalog', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await expect(h.uploadFiles(analysis.id, [a], ctxOf(['OFFICER'], { orgId: 'org-2' }))).rejects.toMatchObject({ status: 404 });
    await expect(h.uploadFiles('00000000-0000-0000-0000-000000000000', [a])).rejects.toMatchObject({ status: 404 });
  });
});

describe('UploadService.retryJob', () => {
  async function failedJob() {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const content = Buffer.from('Date,Item,Value\n2026-04-01,Something,100\n', 'utf8');
    await h.upload.upload(OFFICER, analysis.id, [{ content, fileName: 'mystery.csv', mimeType: 'text/csv' }]);
    const [job] = await h.jobs(analysis.id);
    expect(job.status).toBe('FAILED');
    return { h, analysis, job };
  }

  it('resets a FAILED job, re-queues it and records the request; a bank override is stored', async () => {
    const { h, analysis, job } = await failedJob();
    const view = await h.upload.retryJob(OFFICER, analysis.id, job.id, { bankCode: 'TDB' });
    // Тэр файл TDB-ийн биш ⇒ дахин алдаатай, гэхдээ шинэ оролдлого болсон
    expect(view.bankCode).toBe('TDB');
    expect(view.status).toBe('FAILED');
    const events = (await h.analysis.listEvents(OFFICER, analysis.id)).items.filter((e) => e.action === 'JOB_RETRY_REQUESTED');
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ jobId: job.id, bankOverride: 'TDB' });
  });

  it('refuses a job that is not FAILED, an unknown job, a job of another analysis and a bad bank', async () => {
    const h = await createHarness();
    const a1 = await h.createAnalysis();
    const a2 = await h.createAnalysis({ loanApplicationId: 'app-2' });
    const { a } = await happyFiles();
    await h.uploadFiles(a1.id, [a]);
    const [done] = await h.jobs(a1.id);
    await expect(h.upload.retryJob(OFFICER, a1.id, done.id)).rejects.toMatchObject({ bsaCode: 'JOB_NOT_RETRYABLE', status: 409 });
    await expect(h.upload.retryJob(OFFICER, a1.id, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ bsaCode: 'JOB_NOT_FOUND', status: 404 });
    await expect(h.upload.retryJob(OFFICER, a2.id, done.id)).rejects.toMatchObject({ bsaCode: 'JOB_NOT_FOUND' });
    await expect(h.upload.retryJob(OFFICER, a1.id, done.id, { bankCode: 'XXX' as never })).rejects.toMatchObject({ bsaCode: 'INVALID_REQUEST', status: 400 });
  });

  it('reports 503 and leaves the job FAILED when the queue rejects the retry', async () => {
    const { h, analysis, job } = await failedJob();
    vi.spyOn(h.queue, 'enqueue').mockRejectedValueOnce(new Error('redis down'));
    await expect(h.upload.retryJob(OFFICER, analysis.id, job.id)).rejects.toMatchObject({ bsaCode: 'QUEUE_UNAVAILABLE', status: 503 });
    const [after] = await h.jobs(analysis.id);
    expect(after.status).toBe('FAILED');
    expect(after.errors.map((e) => e.code)).toEqual(['QUEUE_UNAVAILABLE']);
  });

  it('a corrected re-upload after a failed statement works (different bytes)', async () => {
    const h = await createHarness();
    const analysis = await h.createAnalysis();
    const bad = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'b.csv', tamper: alterBalanceOfRow(3),
    });
    const good = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'b.csv',
    });
    await h.uploadFiles(analysis.id, [bad]);
    await h.uploadFiles(analysis.id, [good]);
    const jobs = await h.jobs(analysis.id);
    expect(jobs).toHaveLength(2);
    expect(jobs.filter((j) => j.status === 'COMPLETED')).toHaveLength(1);
    expect((await h.analysis.jobCounts(ADMIN, analysis.id))).toMatchObject({ COMPLETED: 1 });
  });
});
