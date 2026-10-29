// BSA REST — E2E (in-memory): ЖИНХЭНЭ BsaModule + main.ts-тэй ижил configureBsaApp + supertest. Repository/object store/queue in-memory, харин
// pdf-lib-ээр хийсэн SYNTHETIC PDF хуулга ЖИНХЭНЭ text extractor → parser → verifier → classifier → DTI-аар дамжина. Парсерууд бодит банкны
// хуулгаар баталгаажаагүй (TODO(samples)) — энэ тест нь HTTP давхарга ба урсгалын логикийг шалгана, банкны бодит форматыг БИШ.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImportQueueError, type ImportJobHandler } from '../../common/import-queue';
import type { ImportQueue } from '../../common/infra.ports';
import { ACCOUNT_B, HOLDER, OPENING_B, accountBTxns, happyFiles, toLatin } from '../testing/scenario';
import { buildStatementFile } from '../testing/statement-files';
import { alterBalanceOfRow } from '../testing/tamper';
import { analysisBody, createE2eApp, type E2eApp, type E2eOptions } from './e2e-app';
import { allTransactions, createAnalysis, expectError, expectNoPii, expectReadScopes, runFullFlow, waitForJobs, type JobBody } from './flow';

const FIXTURES = join(__dirname, '..', '..', '..', '..', '..', 'test-fixtures', 'bsa', 'text-extraction');

let current: E2eApp | null = null;
async function boot(o: E2eOptions = {}): Promise<E2eApp> {
  current = await createE2eApp(o);
  return current;
}
afterEach(async () => {
  await current?.close();
  current = null;
});

/** Дараалалд орсон ажлыг `drain()` дуудах хүртэл боловсруулахгүй (PENDING төлөв, JOBS_IN_PROGRESS шалгахад) */
class ManualQueue implements ImportQueue {
  readonly waiting: string[] = [];
  private handler: ImportJobHandler | null = null;
  failEnqueue = false;
  async enqueue(jobId: string): Promise<void> {
    if (this.failEnqueue) throw new ImportQueueError('REDIS_UNAVAILABLE', 'synthetic outage');
    this.waiting.push(jobId);
  }
  async start(handler: ImportJobHandler): Promise<void> {
    this.handler = handler;
  }
  async close(): Promise<void> {
    this.handler = null;
  }
  async drain(): Promise<void> {
    for (const id of this.waiting.splice(0)) await this.handler?.(id, { attempt: 1, attempts: 1, isLastAttempt: true });
  }
}

const pdfOf = async (opts: { name?: string; tamper?: ReturnType<typeof alterBalanceOfRow>; noBankName?: boolean } = {}) =>
  buildStatementFile({
    bank: 'MBANK', txns: toLatin(accountBTxns()), opening: OPENING_B, format: 'pdf', accountNo: ACCOUNT_B, iban: null, holder: HOLDER,
    fileName: opts.name ?? 'zxq-secret-b.pdf', ...(opts.tamper ? { tamper: opts.tamper } : {}),
    ...(opts.noBankName ? { overrides: { header: { titleLines: ['SYNTHETIC TEST DATA - NOT A REAL STATEMENT', 'Account statement'] } } } : {}),
  });

describe('BSA REST API e2e: full flow (in-memory)', () => {
  it('create -> upload 2 PDFs -> jobs -> overview -> filters -> reclassify -> recalculate -> breakdown -> finalize -> scoring input', async () => {
    const e = await boot();
    const { analysisId } = await runFullFlow(e);
    await expectReadScopes(e, analysisId);
    // Domain event: ажил бүрт нэг StatementImported
    expect(e.publisher.eventsOfType('StatementImported').map((ev) => [ev.status, ev.rows]).sort()).toEqual([['COMPLETED', 18], ['COMPLETED', 9]]);
    // PII лог руу гараагүй (регистр, данс, нэр, гүйлгээний утга)
    expectNoPii(e.logs.join('\n'));
  }, 60_000);

  it('echoes X-Correlation-Id, replaces an unsafe one and never sends X-Powered-By', async () => {
    const e = await boot();
    const ok = await e.api.as('officer', { 'X-Correlation-Id': 'corr-e2e-1' }).get('/bsa/analyses');
    expect(ok.headers['x-correlation-id']).toBe('corr-e2e-1');
    expect(ok.headers['x-powered-by']).toBeUndefined();
    const bad = await e.api.as('officer', { 'X-Correlation-Id': 'has space' }).get('/bsa/analyses/does-not-exist');
    expect(expectError(bad, 404, 'NOT_FOUND').correlationId).toBe(bad.headers['x-correlation-id']);
    expect(bad.headers['x-correlation-id']).not.toBe('has space');
    const withId = expectError(await e.api.as('officer', { 'X-Correlation-Id': 'corr-e2e-2' }).get('/bsa/analyses/does-not-exist'), 404, 'NOT_FOUND');
    expect(withId.correlationId).toBe('corr-e2e-2');
  });
});

describe('BSA REST API e2e: request validation and error envelope', () => {
  it('rejects malformed bodies with VALIDATION_FAILED and never echoes the submitted values', async () => {
    const e = await boot();
    const res = await e.api.post('/bsa/analyses', analysisBody({ periodMonths: 'zxq-secret', proposedMonthlyPayment: 'zxq-secret', customerId: 5 }));
    const body = expectError(res, 400, 'VALIDATION_FAILED');
    expect(body.issues?.map((i) => i.path).sort()).toEqual(['customerId', 'periodMonths', 'proposedMonthlyPayment']);
    expect(body.issues?.every((i) => typeof i.code === 'string')).toBe(true);
    // zod-ийн англи мессеж, оруулсан утга хариунд байхгүй
    expect(JSON.stringify(res.body)).not.toMatch(/Expected|received|zxq/i);
    expectError(await e.api.post('/bsa/analyses', {}), 400, 'VALIDATION_FAILED');
    expectError(await e.api.post('/bsa/analyses', analysisBody({ periodMonths: 5 })), 400, 'PERIOD_NOT_ALLOWED');
  });

  it('rejects invalid JSON, oversize JSON and non-JSON content types', async () => {
    const e = await boot();
    const invalid = await e.api.post('/bsa/analyses').set('Content-Type', 'application/json').send('{"loanApplicationId": zxq-secret');
    expectError(invalid, 400, 'BAD_REQUEST');
    expect(JSON.stringify(invalid.body)).not.toContain('Unexpected');
    const huge = await e.api.post('/bsa/analyses').set('Content-Type', 'application/json').send(JSON.stringify({ note: 'x'.repeat(1_100_000) }));
    expectError(huge, 413, 'PAYLOAD_TOO_LARGE');
    expectError(await e.api.post('/bsa/analyses').set('Content-Type', 'text/plain').send('hello'), 400, 'VALIDATION_FAILED');
  });

  it('validates path ids and query strings strictly', async () => {
    const e = await boot();
    expectError(await e.api.get('/bsa/analyses/a%20b'), 400, 'VALIDATION_FAILED');
    expectError(await e.api.get('/bsa/analyses?bogus=1'), 400, 'VALIDATION_FAILED');
    expectError(await e.api.get('/bsa/analyses?pageSize=0'), 400, 'VALIDATION_FAILED');
    expectError(await e.api.get('/bsa/analyses?pageSize=201'), 400, 'VALIDATION_FAILED');
    expectError(await e.api.get('/bsa/analyses?status=NOPE'), 400, 'VALIDATION_FAILED');
    expectError(await e.api.get('/bsa/jobs?status=NOPE'), 400, 'VALIDATION_FAILED');
    const { id } = await createAnalysis(e.api);
    expectError(await e.api.get(`/bsa/analyses/${id}/transactions?dateFrom=2026-06-01&dateTo=2026-05-01`), 400, 'VALIDATION_FAILED');
    expectError(await e.api.get(`/bsa/analyses/${id}/transactions?amountMin=5&amountMax=1`), 400, 'VALIDATION_FAILED');
    expectError(await e.api.get(`/bsa/analyses/${id}/transactions?limit=1001`), 400, 'VALIDATION_FAILED');
    expectError(await e.api.get(`/bsa/analyses/${id}/transactions?sort=RANDOM`), 400, 'VALIDATION_FAILED');
    expectError(await e.api.get(`/bsa/analyses/${id}/transactions?category=`.concat('x'.repeat(65))), 400, 'VALIDATION_FAILED');
    expectError(await e.api.post(`/bsa/analyses/${id}/reclassify`, { transactionIds: [], categoryCode: 'SALARY' }), 400, 'VALIDATION_FAILED');
    expectError(await e.api.post(`/bsa/analyses/${id}/reclassify`, { transactionIds: ['t'], categoryCode: 'SALARY', similarBy: 'COLOR' }), 400, 'VALIDATION_FAILED');
  });

  it('answers unknown routes and unknown resources with the same envelope (no framework text)', async () => {
    const e = await boot();
    const route = expectError(await e.api.get('/bsa/nothing'), 404, 'NOT_FOUND');
    expect(route.message).not.toMatch(/Cannot GET/);
    expectError(await e.api.get('/bsa/analyses/00000000-0000-0000-0000-000000000000'), 404, 'NOT_FOUND');
    expectError(await e.api.get('/bsa/jobs/00000000-0000-0000-0000-000000000000'), 404, 'JOB_NOT_FOUND');
  });

  it('maps unexpected failures to INTERNAL_ERROR without leaking the cause (response or logs)', async () => {
    const e = await boot();
    const { id } = await createAnalysis(e.api);
    const repo = e.memory!;
    const original = repo.analyses.getById.bind(repo.analyses);
    repo.analyses.getById = async () => {
      throw new Error('zxq-secret database exploded for УБ90010203');
    };
    const res = await e.api.get(`/bsa/analyses/${id}`);
    expectError(res, 500, 'INTERNAL_ERROR');
    repo.analyses.getById = original;
    expectNoPii(e.logs.join('\n'));
    expect(e.logs.join('\n')).toContain('INTERNAL_ERROR');
    expect((await e.api.get(`/bsa/analyses/${id}`)).status).toBe(200);
  });
});

describe('BSA REST API e2e: access control', () => {
  it('rejects missing or invalid gateway headers', async () => {
    const e = await boot();
    const { default: request } = await import('supertest');
    const server = e.app.getHttpServer();
    expectError(await request(server).get('/api/bsa/analyses'), 401, 'UNAUTHENTICATED');
    expectError(await request(server).get('/api/bsa/analyses').set({ 'X-User-Id': 'u1' }), 403, 'FORBIDDEN');
    expectError(await request(server).get('/api/bsa/analyses').set({ 'X-User-Id': 'u1', 'X-Roles': 'GOD' }), 403, 'FORBIDDEN');
    expectError(await request(server).get('/api/bsa/analyses').set({ 'X-User-Id': 'u 1', 'X-Roles': 'ADMIN' }), 401, 'UNAUTHENTICATED');
    // Толгойн алдаа PII-гүй: лог дээр зөвхөн маршрут, статус
    expectNoPii(e.logs.join('\n'));
  });

  it('allows writes only to OFFICER / BRANCH_MANAGER / ADMIN and keeps APPROVER read-only', async () => {
    const e = await boot();
    expectError(await e.api.as('approver').post('/bsa/analyses', analysisBody()), 403, 'FORBIDDEN');
    const { id } = await createAnalysis(e.api.as('officer'));
    const { a } = await happyFiles({ format: 'pdf' });
    const approver = e.api.as('approver');
    expectError(await approver.upload(id, [a]), 403, 'FORBIDDEN');
    expectError(await approver.post(`/bsa/analyses/${id}/recalculate`, { proposedMonthlyPayment: 1 }), 403, 'FORBIDDEN');
    expectError(await approver.post(`/bsa/analyses/${id}/reclassify`, { transactionIds: ['t'], categoryCode: 'SALARY' }), 403, 'FORBIDDEN');
    expectError(await approver.post(`/bsa/analyses/${id}/finalize`), 403, 'FORBIDDEN');
    expectError(await approver.del(`/bsa/analyses/${id}`), 403, 'FORBIDDEN');
    expectError(await approver.post('/bsa/jobs/j-1/retry'), 403, 'FORBIDDEN');
    // Унших нь бүгд зөвшөөрөгдсөн
    for (const path of [`/bsa/analyses/${id}`, `/bsa/analyses/${id}/imports`, `/bsa/analyses/${id}/history`, `/bsa/analyses`, '/bsa/jobs', '/bsa/categories']) {
      expect((await approver.get(path)).status, path).toBe(200);
    }
    // Салбарын захирал өөрийн салбарын шинжилгээнд бичнэ
    expect((await e.api.as('manager').post(`/bsa/analyses/${id}/recalculate`, { proposedMonthlyPayment: 400_000 })).status).toBe(200);
  });

  it('restricts rule management, rule listing and retention to ADMIN', async () => {
    const e = await boot();
    const rule = { direction: 'INCOME', matchType: 'KEYWORD', pattern: 'bonus pay', categoryCode: 'SALARY', priority: 250 };
    for (const who of ['officer', 'manager', 'approver'] as const) {
      expectError(await e.api.as(who).get('/bsa/rules'), 403, 'FORBIDDEN');
      expectError(await e.api.as(who).post('/bsa/rules', rule), 403, 'FORBIDDEN');
      expectError(await e.api.as(who).post('/bsa/admin/retention/run', {}), 403, 'FORBIDDEN');
    }
    expect((await e.api.as('admin').get('/bsa/rules')).status).toBe(200);
    expect((await e.api.as('admin').post('/bsa/admin/retention/run', {})).status).toBe(200);
  });

  it('hides other organizations (404) and denies other branches / other officers (403) on every analysis route', async () => {
    const e = await boot();
    const { id } = await createAnalysis(e.api.as('officer'));
    const { a } = await happyFiles({ format: 'pdf' });
    const routes: Array<[string, (api: ReturnType<E2eApp['api']['as']>) => ReturnType<E2eApp['api']['get']>]> = [
      ['GET :id', (api) => api.get(`/bsa/analyses/${id}`)],
      ['GET imports', (api) => api.get(`/bsa/analyses/${id}/imports`)],
      ['GET transactions', (api) => api.get(`/bsa/analyses/${id}/transactions`)],
      ['GET breakdown', (api) => api.get(`/bsa/analyses/${id}/breakdown`)],
      ['GET history', (api) => api.get(`/bsa/analyses/${id}/history`)],
      ['GET summary', (api) => api.get(`/bsa/analyses/${id}/summary`)],
      ['GET scoring-input', (api) => api.get(`/bsa/analyses/${id}/scoring-input`)],
      ['POST imports', (api) => api.upload(id, [a])],
      ['POST recalculate', (api) => api.post(`/bsa/analyses/${id}/recalculate`, { proposedMonthlyPayment: 1 })],
      ['POST reclassify', (api) => api.post(`/bsa/analyses/${id}/reclassify`, { transactionIds: ['t'], categoryCode: 'SALARY' })],
      ['POST finalize', (api) => api.post(`/bsa/analyses/${id}/finalize`)],
      ['DELETE', (api) => api.del(`/bsa/analyses/${id}`)],
    ];
    for (const [name, call] of routes) {
      expectError(await call(e.api.as('otherOrgAdmin')), 404, 'NOT_FOUND');
      for (const who of ['officer2', 'managerOtherBranch', 'officerOtherBranch'] as const) {
        expect((await call(e.api.as(who))).status, `${name} as ${who}`).toBe(403);
      }
    }
    // Хэн ч шинжилгээг устгаагүй
    expect((await e.api.as('admin').get(`/bsa/analyses/${id}`)).status).toBe(200);
  });

  it('scopes the analysis and job lists by role (officer: own, manager: branch, admin/approver: organization)', async () => {
    const e = await boot();
    const { a } = await happyFiles({ format: 'pdf' });
    const mine = await createAnalysis(e.api.as('officer'));
    const theirs = await createAnalysis(e.api.as('officer2'), { loanApplicationId: 'app-2' });
    const elsewhere = await createAnalysis(e.api.as('officerOtherBranch'), { loanApplicationId: 'app-3' });
    expect((await e.api.as('officer').upload(mine.id, [a])).status).toBe(202);
    await waitForJobs(e.api.as('officer'), mine.id, 1);
    const ids = async (who: Parameters<E2eApp['api']['as']>[0]): Promise<string[]> =>
      ((await e.api.as(who).get('/bsa/analyses')).body.items as Array<{ id: string }>).map((x) => x.id).sort();
    expect(await ids('officer')).toEqual([mine.id]);
    expect(await ids('officer2')).toEqual([theirs.id]);
    expect(await ids('manager')).toEqual([mine.id, theirs.id].sort());
    expect(await ids('managerOtherBranch')).toEqual([elsewhere.id]);
    expect(await ids('admin')).toEqual([mine.id, theirs.id, elsewhere.id].sort());
    expect(await ids('approver')).toEqual([mine.id, theirs.id, elsewhere.id].sort());
    expect(await ids('otherOrgAdmin')).toEqual([]);
    // Ажлын жагсаалт ижил хүрээтэй
    const jobTotal = async (who: Parameters<E2eApp['api']['as']>[0]): Promise<number> => (await e.api.as(who).get('/bsa/jobs')).body.total as number;
    expect([await jobTotal('officer'), await jobTotal('officer2'), await jobTotal('manager'), await jobTotal('managerOtherBranch'), await jobTotal('admin')]).toEqual([1, 0, 1, 0, 1]);
    // Өөр ЗЭЗ / салбарын ажлыг шууд id-аар авах боломжгүй
    const jobId = ((await e.api.as('officer').get('/bsa/jobs')).body.items as JobBody[])[0].id;
    expect((await e.api.as('officer2').get(`/bsa/jobs/${jobId}`)).status).toBe(403);
    expectError(await e.api.as('otherOrgAdmin').get(`/bsa/jobs/${jobId}`), 404, 'JOB_NOT_FOUND');
  });

  it('takes the branch of a non-admin creator from the gateway header and lets only ADMIN choose it', async () => {
    const e = await boot();
    const officer = await e.api.as('officer').post('/bsa/analyses', analysisBody({ branchId: 'br-2' }));
    expect(officer.body.branchId).toBe('br-1'); // бие дэх branchId үл тооно
    const admin = await e.api.as('admin').post('/bsa/analyses', analysisBody({ branchId: 'br-2', loanApplicationId: 'app-9' }));
    expect(admin.body.branchId).toBe('br-2');
  });
});

describe('BSA REST API e2e: uploads', () => {
  it('rejects an oversize file with 413 FILE_TOO_LARGE (limit from BsaSettings)', async () => {
    const e = await boot({ settings: { maxUploadBytes: 1_000 } });
    const { id } = await createAnalysis(e.api);
    const { a } = await happyFiles({ format: 'pdf' });
    expect(a.content.length).toBeGreaterThan(1_000);
    const body = expectError(await e.api.upload(id, [a]), 413, 'FILE_TOO_LARGE');
    expect(body.details).toMatchObject({ maxBytes: 1_000 });
    expect((await e.api.get(`/bsa/analyses/${id}/imports`)).body.total).toBe(0);
  });

  it('rejects too many files with 400 TOO_MANY_FILES, an empty request with NO_FILES and a wrong field name', async () => {
    const e = await boot({ settings: { maxFilesPerUpload: 2 } });
    const { id } = await createAnalysis(e.api);
    const { a, b } = await happyFiles({ format: 'pdf' });
    const third = { ...a, fileName: 'third.pdf', content: Buffer.concat([a.content, Buffer.from('\n%% third')]) };
    expectError(await e.api.upload(id, [a, b, third]), 400, 'TOO_MANY_FILES');
    expectError(await e.api.post(`/bsa/analyses/${id}/imports`), 400, 'NO_FILES');
    expectError(await e.api.post(`/bsa/analyses/${id}/imports`).field('banks', '[]'), 400, 'NO_FILES');
    expectError(await e.api.post(`/bsa/analyses/${id}/imports`).attach('file', a.content, 'x.pdf'), 400, 'UNEXPECTED_FILE_FIELD');
    expect((await e.api.get(`/bsa/analyses/${id}/imports`)).body.total).toBe(0);
  });

  it('rejects unsupported and empty files with 415 / 400 and per-file outcomes without echoing the file', async () => {
    const e = await boot();
    const { id } = await createAnalysis(e.api);
    const exe = await e.api.upload(id, [{ content: Buffer.from('MZ\x90\x00\x03\x00zxq-secret'), fileName: 'zxq-secret.exe', mimeType: 'application/octet-stream' }]);
    const body = expectError(exe, 415, 'FILE_UNSUPPORTED');
    expect(body.details).toMatchObject({ accepted: 0, duplicates: 0, rejected: 1, outcomes: [{ index: 0, status: 'REJECTED', code: 'FILE_UNSUPPORTED' }] });
    const xlsx = await e.api.upload(id, [{ content: Buffer.from('PK\x03\x04zxq-secret'), fileName: 'zxq-secret.xlsx', mimeType: 'application/vnd.ms-excel' }]);
    expectError(xlsx, 415, 'XLSX_UNSUPPORTED');
    const empty = await e.api.upload(id, [{ content: Buffer.alloc(0), fileName: 'empty.pdf', mimeType: 'application/pdf' }]);
    expect([400, 415]).toContain(empty.status);
    expect((empty.body as { code: string }).code).toBe('FILE_EMPTY');
    expect((await e.api.get(`/bsa/analyses/${id}/imports`)).body.total).toBe(0);
  });

  it('reports a duplicate file per file: 200 when everything is a duplicate, 202 with mixed outcomes otherwise', async () => {
    const e = await boot();
    const { id } = await createAnalysis(e.api);
    const { a, b } = await happyFiles({ format: 'pdf' });
    const first = await e.api.upload(id, [a]);
    expect(first.status).toBe(202);
    const firstJob = first.body.outcomes[0].jobId as string;
    await waitForJobs(e.api, id, 1);
    const dup = await e.api.upload(id, [a]);
    expect(dup.status).toBe(200);
    expect(dup.body).toEqual({ outcomes: [{ index: 0, status: 'DUPLICATE', existingJobId: firstJob }], accepted: 0, duplicates: 1, rejected: 0 });
    // Давхцсан файл + шинэ файл + дэмжигдээгүй файл нэг хүсэлтэд
    const mixed = await e.api.upload(id, [
      a,
      b,
      { content: Buffer.from('MZ\x90\x00binary'), fileName: 'x.exe', mimeType: 'application/octet-stream' },
    ]);
    expect(mixed.status).toBe(202);
    expect(mixed.body).toMatchObject({ accepted: 1, duplicates: 1, rejected: 1 });
    expect((mixed.body.outcomes as Array<{ status: string }>).map((o) => o.status)).toEqual(['DUPLICATE', 'ACCEPTED', 'REJECTED']);
    const jobs = await waitForJobs(e.api, id, 2);
    expect(jobs.every((j) => j.status === 'COMPLETED')).toBe(true);
    // Хоёр удаа ижил файл нэг хүсэлтэд: хоёр дахь нь давхардал
    const e2 = await boot();
    const second = await createAnalysis(e2.api);
    const twice = await e2.api.upload(second.id, [a, { ...a, fileName: 'copy.pdf' }]);
    expect((twice.body.outcomes as Array<{ status: string }>).map((o) => o.status)).toEqual(['ACCEPTED', 'DUPLICATE']);
  });

  it('lets the client pick banks with the optional "banks" JSON field and validates it', async () => {
    const e = await boot();
    const { id } = await createAnalysis(e.api);
    const file = await pdfOf({ noBankName: true });
    expectError(await e.api.upload(id, [file], 'not json'), 400, 'VALIDATION_FAILED');
    expectError(await e.api.upload(id, [file], ['NOPE']), 400, 'VALIDATION_FAILED');
    const ok = await e.api.upload(id, [file], ['MBANK']); // файлын толгойд банкны нэр байхгүй ⇒ гараар заасан
    expect(ok.status).toBe(202);
    const [job] = await waitForJobs(e.api, id, 1);
    expect(job).toMatchObject({ status: 'COMPLETED', bankCode: 'MBANK', rowsDone: 9 });
  });

  it('answers 404 for an unknown analysis and 409 once the analysis is no longer a draft', async () => {
    const e = await boot();
    const { a } = await happyFiles({ format: 'pdf' });
    expectError(await e.api.upload('00000000-0000-0000-0000-000000000000', [a]), 404, 'NOT_FOUND');
    const { id } = await createAnalysis(e.api);
    await e.api.upload(id, [a]);
    await waitForJobs(e.api, id, 1);
    expect((await e.api.post(`/bsa/analyses/${id}/finalize`)).status).toBe(200);
    expectError(await e.api.upload(id, [a]), 409, 'ANALYSIS_NOT_DRAFT');
  });

  it('answers 503 QUEUE_UNAVAILABLE when the queue is down and keeps the analysis usable', async () => {
    const queue = new ManualQueue();
    const e = await boot({ queue });
    const { id } = await createAnalysis(e.api);
    const { a } = await happyFiles({ format: 'pdf' });
    queue.failEnqueue = true;
    const down = await e.api.upload(id, [a]);
    expectError(down, 503, 'QUEUE_UNAVAILABLE');
    expect(down.body.details.outcomes[0]).toMatchObject({ status: 'REJECTED', code: 'QUEUE_UNAVAILABLE' });
    // Ажил үүссэн боловч дараалалд орж чадаагүй ⇒ FAILED (QUEUE_UNAVAILABLE); файл хадгалагдсан тул дахин upload нь давхардал
    const [stuck] = await waitForJobs(e.api, id, 1);
    expect(stuck).toMatchObject({ status: 'FAILED', errors: [{ code: 'QUEUE_UNAVAILABLE' }] });
    expect(await e.api.upload(id, [a])).toMatchObject({ status: 200, body: { duplicates: 1 } });
    expectError(await e.api.post(`/bsa/jobs/${stuck.id}/retry`), 503, 'QUEUE_UNAVAILABLE'); // Redis сэргээгүй байхад
    queue.failEnqueue = false;
    expect((await e.api.post(`/bsa/jobs/${stuck.id}/retry`)).status).toBe(202); // сэргэсний дараа «дахин оруулах»
    await queue.drain();
    expect((await waitForJobs(e.api, id, 1))[0]).toMatchObject({ id: stuck.id, status: 'COMPLETED', rowsDone: 18 });
  });
});

describe('BSA REST API e2e: import failures, retry and job states', () => {
  it('fails a tampered statement with BALANCE_CHAIN_BREAK, stores no rows and blocks the push (BSA-FR-2.2)', async () => {
    const e = await boot();
    const { id } = await createAnalysis(e.api);
    const bad = await pdfOf({ name: 'zxq-secret-bad.pdf', tamper: alterBalanceOfRow(3) });
    expect((await e.api.upload(id, [bad])).status).toBe(202);
    const [job] = await waitForJobs(e.api, id, 1);
    expect(job.status).toBe('FAILED');
    expect(job.errors.map((x) => x.code)).toContain('BALANCE_CHAIN_BREAK');
    expect(job.rowsDone).toBe(0);
    expectNoPii(JSON.stringify(job.errors));
    expect(await allTransactions(e.api, id)).toHaveLength(0);

    const overview = await e.api.get(`/bsa/analyses/${id}`);
    expect(overview.body).toMatchObject({ summary: null, details: null, jobs: { counts: { FAILED: 1, COMPLETED: 0 } } });
    expect((overview.body.warnings as Array<{ code: string; severity: string }>).find((w) => w.code === 'BALANCE_CHAIN_BREAK')?.severity).toBe('ERROR');
    expectError(await e.api.get(`/bsa/analyses/${id}/breakdown`), 422, 'NO_TRANSACTIONS');
    expectError(await e.api.get(`/bsa/analyses/${id}/summary`), 404, 'SUMMARY_NOT_AVAILABLE');
    expectError(await e.api.post(`/bsa/analyses/${id}/finalize`), 422, 'NO_COMPLETED_IMPORT');
    expectError(await e.api.get(`/bsa/analyses/${id}/scoring-input`), 409, 'NOT_ANALYZED');
    expect((await e.api.get('/bsa/jobs?status=FAILED')).body).toMatchObject({ total: 1, counts: { FAILED: 1 } });
    // Баталгаажуулалтын алдаа эцсийн: дахин оруулахад ижил алдаа (файл өөрчлөгдөөгүй)
    const retry = await e.api.post(`/bsa/jobs/${job.id}/retry`);
    expect(retry.status).toBe(202);
    const [again] = await waitForJobs(e.api, id, 1);
    expect(again.status).toBe('FAILED');
    expect(again.errors.map((x) => x.code)).toContain('BALANCE_CHAIN_BREAK');
    expect(e.publisher.eventsOfType('StatementImported').map((ev) => ev.status)).toEqual(['FAILED', 'FAILED']);
    expectNoPii(e.logs.join('\n'));
  });

  it('retries a FAILED job with a bank override (BANK_NOT_DETECTED -> COMPLETED) and refuses other retries', async () => {
    const e = await boot();
    const { id } = await createAnalysis(e.api);
    expect((await e.api.upload(id, [await pdfOf({ noBankName: true })])).status).toBe(202);
    const [failed] = await waitForJobs(e.api, id, 1);
    expect(failed).toMatchObject({ status: 'FAILED', bankCode: null });
    expect(failed.errors.map((x) => x.code)).toEqual(['BANK_NOT_DETECTED']);

    expectError(await e.api.post(`/bsa/jobs/${failed.id}/retry`, { bankCode: 'NOPE' }), 400, 'VALIDATION_FAILED');
    expectError(await e.api.post(`/bsa/jobs/${failed.id}/retry`, { extra: 1 }), 400, 'VALIDATION_FAILED');
    expectError(await e.api.as('officer2').post(`/bsa/jobs/${failed.id}/retry`, { bankCode: 'MBANK' }), 403, 'FORBIDDEN');
    expectError(await e.api.as('otherOrgAdmin').post(`/bsa/jobs/${failed.id}/retry`, { bankCode: 'MBANK' }), 404, 'JOB_NOT_FOUND');
    expectError(await e.api.post('/bsa/jobs/00000000-0000-0000-0000-000000000000/retry', { bankCode: 'MBANK' }), 404, 'JOB_NOT_FOUND');

    const retry = await e.api.post(`/bsa/jobs/${failed.id}/retry`, { bankCode: 'MBANK' });
    expect(retry.status).toBe(202);
    expect(retry.body).toMatchObject({ id: failed.id, status: 'PENDING', bankCode: 'MBANK', errors: [] });
    const [done] = await waitForJobs(e.api, id, 1);
    expect(done).toMatchObject({ id: failed.id, status: 'COMPLETED', bankCode: 'MBANK', rowsDone: 9, errors: [] });
    // Дууссан ажлыг дахин оруулах боломжгүй
    expectError(await e.api.post(`/bsa/jobs/${failed.id}/retry`), 409, 'JOB_NOT_RETRYABLE');
    const history = ((await e.api.get(`/bsa/analyses/${id}/history`)).body.items as Array<{ action: string }>).map((h) => h.action);
    expect(history).toEqual(expect.arrayContaining(['JOB_RETRY_REQUESTED', 'IMPORT_FAILED', 'IMPORT_COMPLETED']));
  });

  it('fails an image that has no readable text and a password-protected PDF with safe codes', async () => {
    const e = await boot();
    const { id } = await createAnalysis(e.api);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    expect((await e.api.upload(id, [{ content: png, fileName: 'scan.png', mimeType: 'image/png' }])).status).toBe(202);
    const locked = readFileSync(join(FIXTURES, 'encrypted-user-password.pdf'));
    expect((await e.api.upload(id, [{ content: locked, fileName: 'locked.pdf', mimeType: 'application/pdf' }])).status).toBe(202);
    const jobs = await waitForJobs(e.api, id, 2);
    expect(jobs.map((j) => j.status)).toEqual(['FAILED', 'FAILED']);
    for (const job of jobs) {
      expect(job.errors).toHaveLength(1);
      expect(job.errors[0].code).toMatch(/^[A-Z_]+$/);
      expect(job.errors[0].message).toMatch(/[Ѐ-ӿ]/);
    }
    expectNoPii(e.logs.join('\n'));
  });

  it('shows PENDING jobs while the worker is busy and refuses finalize / delete until they finish (JOBS_IN_PROGRESS)', async () => {
    const queue = new ManualQueue();
    const e = await boot({ queue });
    const { id } = await createAnalysis(e.api);
    const { a, b } = await happyFiles({ format: 'pdf' });
    expect((await e.api.upload(id, [a, b])).status).toBe(202);
    const pending = await e.api.get(`/bsa/jobs?analysisId=${id}`);
    expect(pending.body.counts).toEqual({ PENDING: 2, PROCESSING: 0, COMPLETED: 0, FAILED: 0 });
    expectError(await e.api.post(`/bsa/analyses/${id}/finalize`), 409, 'JOBS_IN_PROGRESS');
    expectError(await e.api.del(`/bsa/analyses/${id}`), 409, 'JOBS_IN_PROGRESS');
    expectError(await e.api.post(`/bsa/jobs/${pending.body.items[0].id}/retry`), 409, 'JOB_NOT_RETRYABLE');
    await queue.drain();
    const jobs = await waitForJobs(e.api, id, 2);
    expect(jobs.every((j) => j.status === 'COMPLETED')).toBe(true);
    expect((await e.api.post(`/bsa/analyses/${id}/finalize`)).status).toBe(200);
  });
});

describe('BSA REST API e2e: finalize policy (BSA-FR-5.3)', () => {
  it('BLOCK policy refuses the push while suspicious transactions are pending (422) and allows it once cleared', async () => {
    const e = await boot({ settings: { pushPolicyWhenPendingSuspicious: 'BLOCK' }, suspicionPending: 2 });
    const { id } = await createAnalysis(e.api);
    const { a, b } = await happyFiles({ format: 'pdf' });
    await e.api.upload(id, [a, b]);
    await waitForJobs(e.api, id, 2);
    const blocked = expectError(await e.api.post(`/bsa/analyses/${id}/finalize`), 422, 'PENDING_SUSPICIOUS_BLOCK');
    expect(blocked.details).toMatchObject({ pendingSuspiciousCount: 2 });
    expect((await e.api.get(`/bsa/analyses/${id}`)).body.analysis.status).toBe('DRAFT');
    expect((await e.api.get(`/bsa/analyses/${id}`)).body.summary).toMatchObject({ pendingSuspiciousCount: 2 });
    e.suspicion.pending = 0;
    const ok = await e.api.post(`/bsa/analyses/${id}/finalize`);
    expect(ok.status).toBe(200);
    expect(ok.body.summary).toMatchObject({ status: 'ANALYZED', pendingSuspiciousCount: 0 });
  });

  it('WARN policy pushes with a warning and reports the pending count', async () => {
    const e = await boot({ suspicionPending: 3 });
    const { id } = await createAnalysis(e.api);
    const { a } = await happyFiles({ format: 'pdf' });
    await e.api.upload(id, [a]);
    await waitForJobs(e.api, id, 1);
    const res = await e.api.post(`/bsa/analyses/${id}/finalize`);
    expect(res.status).toBe(200);
    expect(res.body.summary.pendingSuspiciousCount).toBe(3);
    expect((res.body.warnings as Array<{ code: string }>).some((w) => /SUSPICIOUS/.test(w.code))).toBe(true);
    expect((await e.api.get(`/bsa/analyses/${id}/scoring-input`)).body.input.pendingSuspiciousCount).toBe(3);
  });

  it('refuses to finalize an analysis that has no completed import (422)', async () => {
    const e = await boot();
    const { id } = await createAnalysis(e.api);
    expectError(await e.api.post(`/bsa/analyses/${id}/finalize`), 422, 'NO_COMPLETED_IMPORT');
    expectError(await e.api.get(`/bsa/analyses/${id}/summary`), 404, 'SUMMARY_NOT_AVAILABLE');
    expectError(await e.api.get(`/bsa/analyses/${id}/breakdown`), 422, 'NO_TRANSACTIONS');
  });
});

describe('BSA REST API e2e: catalog, rules, deletion and retention', () => {
  it('lists the system categories for every role', async () => {
    const e = await boot();
    for (const who of ['officer', 'manager', 'approver', 'admin'] as const) {
      const res = await e.api.as(who).get('/bsa/categories');
      expect(res.status).toBe(200);
      const codes = (res.body as Array<{ code: string }>).map((c) => c.code);
      expect(codes).toEqual(expect.arrayContaining(['SALARY', 'BUSINESS_INCOME', 'LOAN_PAYMENT', 'OWN_TRANSFER_IN', 'OTHER_EXPENSE']));
    }
    expectError(await e.api.get('/bsa/categories?includeInactive=maybe'), 400, 'VALIDATION_FAILED');
  });

  it('lets an admin add a rule that re-classifies one analysis; duplicates and unsafe rules are refused', async () => {
    const e = await boot();
    const { id } = await createAnalysis(e.api);
    const { a, b } = await happyFiles({ format: 'pdf' });
    await e.api.upload(id, [a, b]);
    await waitForJobs(e.api, id, 2);
    const admin = e.api.as('admin');
    const before = (await admin.get('/bsa/rules')).body as unknown[];
    // «sales» (Latin) анхдагч дүрэмд байхгүй ⇒ OTHER_INCOME (10 %). Дүрэм нэмж, шинжилгээг дахин ангилна
    const rule = { direction: 'INCOME', matchType: 'KEYWORD', pattern: 'sales', categoryCode: 'BUSINESS_INCOME', priority: 250 };
    const created = await admin.post('/bsa/rules', { ...rule, analysisId: id });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.rule).toMatchObject({ ...rule, source: 'ADMIN' });
    // Sales 900,000 × 0.85 = 765,000 · баталгаажсан 1,200,000 + 765,000 + 60,000 = 2,025,000 · DTI орлого 1,822,500 · ӨОХ 500,000 / 1,822,500 = 27.4 %
    expect(created.body.summary).toMatchObject({ verifiedMonthlyIncome: 2_025_000, dtiIncome: 1_822_500, businessIncomeMonthly: 765_000, dtiPercent: 27.4, dtiLevel: 'LOW' });
    expect(((await admin.get('/bsa/rules')).body as unknown[]).length).toBe(before.length + 1);
    expect((await allTransactions(e.api, id, '&category=BUSINESS_INCOME')).map((t) => t.manualOverride)).toEqual([false, false, false]);

    expectError(await admin.post('/bsa/rules', rule), 409, 'RULE_DUPLICATE');
    expectError(await admin.post('/bsa/rules', { ...rule, pattern: 'other', categoryCode: 'NO_SUCH_CATEGORY' }), 400, 'RULE_INVALID');
    expectError(await admin.post('/bsa/rules', { ...rule, pattern: '(a+)+$', matchType: 'REGEX' }), 400, 'RULE_INVALID');
    expectError(await admin.post('/bsa/rules', { ...rule, priority: -1 }), 400, 'VALIDATION_FAILED');
    expectError(await admin.post('/bsa/rules', { ...rule, source: 'FEEDBACK', analysisId: id, extra: true }), 400, 'VALIDATION_FAILED');
  });

  it('deletes a DRAFT analysis with its files (200) and 404s afterwards', async () => {
    const e = await boot();
    const { id } = await createAnalysis(e.api);
    const { a, b } = await happyFiles({ format: 'pdf' });
    await e.api.upload(id, [a, b]);
    await waitForJobs(e.api, id, 2);
    expect(e.store.keys()).toHaveLength(2);
    const res = await e.api.del(`/bsa/analyses/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deletedObjects: 2, failedObjects: 0 });
    expect(e.store.keys()).toHaveLength(0);
    expectError(await e.api.get(`/bsa/analyses/${id}`), 404, 'NOT_FOUND');
    expect((await e.api.as('admin').get('/bsa/jobs')).body.total).toBe(0);
  });

  it('purges analyses older than the retention period on demand (ADMIN) and leaves recent ones', async () => {
    const e = await boot();
    const old = await createAnalysis(e.api);
    const { a } = await happyFiles({ format: 'pdf' });
    await e.api.upload(old.id, [a]);
    await waitForJobs(e.api, old.id, 1);
    e.clock.advance(4 * 365 * 24 * 3_600_000); // хадгалах хугацаа 3 жил (тохиргоо) ⇒ 4 жилийн дараа
    const recent = await createAnalysis(e.api, { loanApplicationId: 'app-2' });
    const admin = e.api.as('admin');
    expectError(await admin.post('/bsa/admin/retention/run', { limit: 0 }), 400, 'VALIDATION_FAILED');
    const run = await admin.post('/bsa/admin/retention/run', {});
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ examined: 1, purged: 1, objectsDeleted: 1, objectFailures: 0 });
    expectError(await admin.get(`/bsa/analyses/${old.id}`), 404, 'NOT_FOUND');
    expect((await admin.get(`/bsa/analyses/${recent.id}`)).status).toBe(200);
    expect((await admin.post('/bsa/admin/retention/run')).body).toMatchObject({ examined: 0, purged: 0 });
  });
});
