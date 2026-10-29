// Queue worker handler: BullMQ-ийн семантик (UnrecoverableError ⇒ дахин оролдохгүй), attempt-aware (эцсийн оролдлого л FAILED болгоно).
import { describe, expect, it, vi } from 'vitest';
import { ImportJobFailedError } from './import.processor';
import { createHarness, OFFICER } from './testing/harness';
import { accountBTxns, happyFiles, HOLDER, ACCOUNT_B, OPENING_B } from './testing/scenario';
import { buildStatementFile } from './testing/statement-files';
import { alterBalanceOfRow } from './testing/tamper';

describe('ImportProcessor.handle', () => {
  it('returns normally for a completed job and for a job that no longer exists', async () => {
    const h = await createHarness({ startWorker: false });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);
    const [job] = await h.jobs(analysis.id);
    await expect(h.processor.handle(job.id, { attempt: 1, attempts: 3, isLastAttempt: false })).resolves.toBeUndefined();
    expect((await h.jobs(analysis.id))[0].status).toBe('COMPLETED');
    await expect(h.processor.handle(job.id, { attempt: 2, attempts: 3, isLastAttempt: false })).resolves.toBeUndefined();
    await expect(h.processor.handle('00000000-0000-0000-0000-000000000000', { attempt: 1, attempts: 1, isLastAttempt: true })).resolves.toBeUndefined();
  });

  it('throws an UnrecoverableError (no more retries) when the job outcome is FAILED, also on a repeated delivery', async () => {
    const h = await createHarness({ startWorker: false });
    const analysis = await h.createAnalysis();
    const bad = await buildStatementFile({
      bank: 'MBANK', txns: accountBTxns(), opening: OPENING_B, accountNo: ACCOUNT_B, iban: null, holder: HOLDER, fileName: 'bad.csv', tamper: alterBalanceOfRow(3),
    });
    await h.uploadFiles(analysis.id, [bad]);
    const [job] = await h.jobs(analysis.id);

    const first = (await h.processor.handle(job.id, { attempt: 1, attempts: 3, isLastAttempt: false }).catch((e: unknown) => e)) as ImportJobFailedError;
    expect(first).toBeInstanceOf(ImportJobFailedError);
    expect(first.name).toBe('UnrecoverableError');
    expect(first.codes).toContain('BALANCE_CHAIN_BREAK');
    expect(first.jobId).toBe(job.id);
    expect(first.message).not.toMatch(/Bold|5011|ZXQ/i);

    const again = (await h.processor.handle(job.id, { attempt: 2, attempts: 3, isLastAttempt: false }).catch((e: unknown) => e)) as ImportJobFailedError;
    expect(again.name).toBe('UnrecoverableError');
    expect(again.codes).toEqual([]);
    expect(h.publisher.eventsOfType('StatementImported')).toHaveLength(1); // давхар event байхгүй
  });

  it('treats missing attempt info as "not the last attempt": a transient error is rethrown and the job is not failed', async () => {
    const h = await createHarness({ startWorker: false });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.uploadFiles(analysis.id, [a]);
    const [job] = await h.jobs(analysis.id);
    vi.spyOn(h.objects, 'get').mockRejectedValueOnce(new Error('transient'));
    await expect((h.processor.handle as (id: string) => Promise<void>)(job.id)).rejects.toThrow('transient');
    expect((await h.jobs(analysis.id))[0].status).toBe('PROCESSING');
  });

  it('onModuleInit starts the queue worker (jobs queued before start are processed)', async () => {
    const h = await createHarness({ startWorker: false });
    const analysis = await h.createAnalysis();
    const { a } = await happyFiles();
    await h.upload.upload(OFFICER, analysis.id, [{ content: a.content, fileName: 'a.csv', mimeType: 'text/csv' }]);
    expect((await h.jobs(analysis.id))[0].status).toBe('PENDING');
    await h.processor.onModuleInit();
    expect((await h.jobs(analysis.id))[0].status).toBe('COMPLETED');
    await expect(h.processor.start()).rejects.toMatchObject({ code: 'ALREADY_STARTED' });
  });
});
