import 'reflect-metadata';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { BlacklistEntry, BlacklistImportResult, DomainEvent } from '@los/contracts';
import { hashRegisterNo } from '@los/database';
import { BlacklistModule } from './blacklist.module';
import { BLACKLIST_PRISMA } from './blacklist.prisma';
import { BLACKLIST_REPOSITORY } from './blacklist.repository';
import { BLACKLIST_CLOCK, BLACKLIST_IDS, PII_CIPHER } from './blacklist.tokens';
import { InMemoryBlacklistRepository } from './in-memory-blacklist.repository';
import { entryInput, FixedClock, fakeCipher, REGISTER, SequentialIds } from './test-support';

const as = (roles: string, extra: Record<string, string> = {}) => ({ 'X-User-Id': 'user-1', 'X-Roles': roles, 'X-Org-Id': 'org-1', ...extra });
const ADMIN = as('ADMIN');
const CSV_HEADER = 'registerNo,customerType,name,listType,reasonCode,reasonText';
// README-д амласан хэмжээ: MAX_CSV_BYTES-г импортлохгүй — тогтмолыг өөрчилбөл тест унах ёстой.
const FIVE_MB = 5 * 1024 * 1024;

/** Windows-1251 (Excel-ийн кирилл locale-ийн "CSV"): ASCII + кирилл А-я (U+0410..U+044F → 0xC0..0xFF). */
const cp1251 = (text: string) => Buffer.from([...text].map((ch) => {
  const cp = ch.codePointAt(0) as number;
  if (cp < 0x80) return cp;
  if (cp >= 0x410 && cp <= 0x44f) return 0xc0 + (cp - 0x410);
  throw new Error(`no cp1251 mapping for ${ch}`);
}));

const csvHead = (headers: Record<string, string>) =>
  ['POST /api/blacklist/import HTTP/1.1', 'Host: localhost', 'Content-Type: text/csv', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''].join('\r\n');
const statusOf = (raw: string) => Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1]) || null;

/** Толгойг л илгээнэ (body илгээхгүй). Сервер body хүлээвэл timeout болж status=null; хариу ирээд холболтоо хаавал closed=true. */
function rawRequest(port: number, head: string, timeoutMs = 3000): Promise<{ status: number | null; closed: boolean }> {
  return new Promise((resolve) => {
    let data = '';
    const socket = connect(port, '127.0.0.1', () => socket.write(head));
    const done = (closed: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: statusOf(data), closed });
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on('data', (d) => { data += d.toString('latin1'); });
    socket.on('close', () => done(true));
    socket.on('error', () => undefined);
  });
}

/** `Transfer-Encoding: chunked`-ээр 64 KB chunk-уудыг maxBytes хүртэл илгээнэ; сервер таславал зогсоно. */
function streamChunked(port: number, headers: Record<string, string>, maxBytes: number): Promise<{ status: number | null; sent: number; closed: boolean }> {
  return new Promise((resolve) => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const frame = Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from('\r\n')]);
    let sent = 0;
    let data = '';
    let stopped = false;
    const socket = connect(port, '127.0.0.1');
    const finish = (closed: boolean) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: statusOf(data), sent, closed });
    };
    const timer = setTimeout(() => finish(false), 8000);
    socket.on('data', (d) => { data += d.toString('latin1'); });
    socket.on('close', () => finish(true));
    socket.on('error', () => finish(true));
    const pump = () => {
      while (!stopped && sent < maxBytes) {
        sent += chunk.length;
        if (!socket.write(frame)) { socket.once('drain', pump); return; }
      }
      if (!stopped) socket.write('0\r\n\r\n');
    };
    socket.on('connect', () => {
      socket.write(csvHead({ ...headers, 'Transfer-Encoding': 'chunked' }));
      pump();
    });
  });
}

type LogLine = { level: 'log' | 'error' | 'warn' | 'debug' | 'verbose'; text: string };

describe('BlacklistController (HTTP)', () => {
  let app: INestApplication;
  let repo: InMemoryBlacklistRepository;
  let logs: LogLine[];
  const api = () => request(app.getHttpServer());
  /** Nest-ийн бүх лог (route mapping зэрэг), түвшинтэй нь: "алдаа/лог-д регистр орохгүй", "ERROR лог гарахгүй" гэж шалгахад. */
  const capturingLogger = (): LoggerService => {
    const at = (level: LogLine['level']) => (...args: unknown[]) => {
      logs.push({ level, text: args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
    };
    return { log: at('log'), error: at('error'), warn: at('warn'), debug: at('debug'), verbose: at('verbose') };
  };
  const logText = () => logs.map((l) => l.text).join('\n');

  beforeEach(async () => {
    vi.stubEnv('DEFAULT_ORG_ID', '');
    repo = new InMemoryBlacklistRepository();
    const moduleRef = await Test.createTestingModule({ imports: [BlacklistModule] })
      .overrideProvider(BLACKLIST_PRISMA).useValue({})
      .overrideProvider(BLACKLIST_REPOSITORY).useValue(repo)
      .overrideProvider(PII_CIPHER).useValue(fakeCipher)
      .overrideProvider(BLACKLIST_CLOCK).useValue(new FixedClock())
      .overrideProvider(BLACKLIST_IDS).useValue(new SequentialIds())
      .compile();
    logs = [];
    app = moduleRef.createNestApplication({ logger: false });
    app.useLogger(capturingLogger());
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  describe('trusted headers and roles', () => {
    it('answers 401 on every route without X-User-Id', async () => {
      await api().get('/api/blacklist').set({ 'X-Org-Id': 'org-1' }).expect(401);
      await api().get('/api/blacklist/x').set({ 'X-Org-Id': 'org-1' }).expect(401);
      await api().post('/api/blacklist').set({ 'X-Org-Id': 'org-1', 'X-Roles': 'ADMIN' }).send(entryInput()).expect(401);
      await api().post('/api/blacklist/import').set({ 'X-Org-Id': 'org-1', 'X-Roles': 'ADMIN' }).send({ rows: [] }).expect(401);
    });

    it('answers 400 without X-Org-Id when DEFAULT_ORG_ID is unset, and falls back to DEFAULT_ORG_ID when set', async () => {
      const noOrg = { 'X-User-Id': 'user-1', 'X-Roles': 'ADMIN' };
      await api().get('/api/blacklist').set(noOrg).expect(400);

      vi.stubEnv('DEFAULT_ORG_ID', 'org-env');
      const created = await api().post('/api/blacklist').set(noOrg).send(entryInput()).expect(201);
      expect(created.body.orgId).toBe('org-env');
    });

    it.each(['OFFICER', 'APPROVER', 'BRANCH_MANAGER', 'ADMIN', ''])('lets role "%s" read', async (roles) => {
      await api().get('/api/blacklist').set(as(roles)).expect(200);
    });

    it.each(['OFFICER', 'APPROVER', 'BOGUS', ''])('forbids writes and import for role "%s"', async (roles) => {
      const { body } = await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(201);
      await api().post('/api/blacklist').set(as(roles)).send(entryInput({ registerNo: 'АА87654321' })).expect(403);
      await api().patch(`/api/blacklist/${body.id}`).set(as(roles)).send({ name: 'x' }).expect(403);
      await api().delete(`/api/blacklist/${body.id}`).set(as(roles)).expect(403);
      await api().post('/api/blacklist/import').set(as(roles)).send({ rows: [] }).expect(403);
      await api().post('/api/blacklist/import').set(as(roles, { 'Content-Type': 'text/csv' })).send(`${CSV_HEADER}\n`).expect(403);
    });

    it.each(['BRANCH_MANAGER', 'ADMIN', 'OFFICER,BRANCH_MANAGER', 'officer, admin'])('lets "%s" write', async (roles) => {
      await api().post('/api/blacklist').set(as(roles)).send(entryInput()).expect(201);
    });

    it('serves only under the /api prefix', async () => {
      await api().get('/blacklist').set(ADMIN).expect(404);
    });
  });

  describe('POST /api/blacklist', () => {
    it('creates an entry (201) that matches the contract and leaks neither hash nor ciphertext', async () => {
      const res = await api().post('/api/blacklist').set(as('BRANCH_MANAGER', { 'X-Branch-Id': 'branch-9' })).send(entryInput()).expect(201);

      expect(BlacklistEntry.parse(res.body)).toMatchObject({ registerNo: REGISTER, orgId: 'org-1', registeredBy: 'user-1', isActive: true, listType: 'DELINQUENT' });
      expect(JSON.stringify(res.body)).not.toMatch(/registerNoHash|registerNoEncrypted|fake:/);
      expect(await repo.findByKey('org-1', hashRegisterNo(REGISTER), 'DELINQUENT')).toMatchObject({ branchId: 'branch-9' });
    });

    it('defaults listType to DELINQUENT', async () => {
      const { listType: _omitted, ...withoutList } = entryInput();
      const res = await api().post('/api/blacklist').set(ADMIN).send(withoutList).expect(201);
      expect(res.body.listType).toBe('DELINQUENT');
    });

    it('answers 409 for an active duplicate and 201 when re-activating an inactive one', async () => {
      const first = await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(201);
      await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(409);

      await api().delete(`/api/blacklist/${first.body.id}`).set(ADMIN).expect(200);
      const again = await api().post('/api/blacklist').set(ADMIN).send(entryInput({ name: 'Шинэ' })).expect(201);
      expect(again.body).toMatchObject({ id: first.body.id, isActive: true, name: 'Шинэ' });
    });

    it('answers 400 with zod issues and no stack for invalid input, and writes nothing', async () => {
      const res = await api().post('/api/blacklist').set(ADMIN).send({ registerNo: '', customerType: 'ROBOT', reasonCode: 'bad code' }).expect(400);

      expect(res.body).toMatchObject({ statusCode: 400, message: 'Validation failed' });
      expect(res.body.issues.map((i: { path: string[] }) => i.path[0]).sort()).toEqual(['customerType', 'name', 'reasonCode', 'registerNo']);
      expect(JSON.stringify(res.body)).not.toMatch(/stack|at .*\.ts/);
      expect(repo.events).toHaveLength(0);
    });

    it('rejects a register that normalizes to nothing', async () => {
      await api().post('/api/blacklist').set(ADMIN).send(entryInput({ registerNo: ' - - ' })).expect(400);
    });

    it('writes exactly one outbox event carrying the correlation id and no plain register', async () => {
      await api().post('/api/blacklist').set(as('ADMIN', { 'X-Correlation-Id': 'corr-abc' })).send(entryInput()).expect(201);

      expect(repo.events).toHaveLength(1);
      expect(DomainEvent.parse(repo.events[0])).toMatchObject({ type: 'BlacklistEntryChanged', correlationId: 'corr-abc', actorId: 'user-1', orgId: 'org-1' });
      expect(JSON.stringify(repo.events)).not.toContain(REGISTER);
    });

    it('generates a correlation id when the header is absent', async () => {
      await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(201);
      expect(repo.events[0].correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    });
  });

  describe('GET /api/blacklist', () => {
    it('lists with default limit 20, newest first, with total', async () => {
      for (let i = 0; i < 25; i++) await api().post('/api/blacklist').set(ADMIN).send(entryInput({ registerNo: `УБ${String(i).padStart(8, '0')}` })).expect(201);

      const res = await api().get('/api/blacklist').set(ADMIN).expect(200);
      expect(res.body.total).toBe(25);
      expect(res.body.items).toHaveLength(20);
      res.body.items.forEach((i: unknown) => BlacklistEntry.parse(i));
    });

    it('supports q (name and register), listType, isActive, limit and offset', async () => {
      await api().post('/api/blacklist').set(ADMIN).send(entryInput({ registerNo: 'УБ11111111', name: 'Бат Болд' })).expect(201);
      const fraud = await api().post('/api/blacklist').set(ADMIN).send(entryInput({ registerNo: 'УБ22222222', name: 'Сараа', listType: 'FRAUD' })).expect(201);
      await api().delete(`/api/blacklist/${fraud.body.id}`).set(ADMIN).expect(200);

      const byName = await api().get('/api/blacklist').query({ q: 'болд' }).set(ADMIN).expect(200);
      expect(byName.body.items.map((i: { registerNo: string }) => i.registerNo)).toEqual(['УБ11111111']);
      const byRegister = await api().get('/api/blacklist').query({ q: 'уб 22222222' }).set(ADMIN).expect(200);
      expect(byRegister.body.items.map((i: { name: string }) => i.name)).toEqual(['Сараа']);
      expect((await api().get('/api/blacklist').query({ listType: 'FRAUD' }).set(ADMIN)).body.total).toBe(1);
      expect((await api().get('/api/blacklist').query({ isActive: 'false' }).set(ADMIN)).body.total).toBe(1);
      expect((await api().get('/api/blacklist').query({ isActive: 'true' }).set(ADMIN)).body.total).toBe(1);
      // Цаг тогтмол тул registeredAt тэнцүү — id өсөхөөр эрэмбэлэгдэнэ.
      const page = await api().get('/api/blacklist').query({ limit: 1, offset: 1 }).set(ADMIN).expect(200);
      expect(page.body).toMatchObject({ total: 2, items: [{ registerNo: 'УБ22222222' }] });
    });

    it.each([{ limit: '101' }, { limit: '0' }, { offset: '-1' }, { offset: '1000001' }, { offset: '1e20' }, { isActive: 'maybe' }])('rejects bad query %o with 400', async (q) => {
      const res = await api().get('/api/blacklist').query(q).set(ADMIN).expect(400);
      expect(res.body.issues).toBeDefined();
    });

    it('accepts the largest allowed offset', async () => {
      const res = await api().get('/api/blacklist').query({ offset: '1000000' }).set(ADMIN).expect(200);
      expect(res.body).toEqual({ total: 0, items: [] });
    });
  });

  describe('GET/PATCH/DELETE /api/blacklist/:id', () => {
    it('gets one entry and 404s for unknown ids and other orgs', async () => {
      const { body } = await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(201);
      expect((await api().get(`/api/blacklist/${body.id}`).set(as('OFFICER')).expect(200)).body.registerNo).toBe(REGISTER);
      await api().get('/api/blacklist/nope').set(ADMIN).expect(404);
      await api().get(`/api/blacklist/${body.id}`).set({ ...ADMIN, 'X-Org-Id': 'org-2' }).expect(404);
    });

    it('patches partially, answers 409 on a key clash and 400 on invalid input', async () => {
      const a = await api().post('/api/blacklist').set(ADMIN).send(entryInput({ registerNo: 'УБ11111111' })).expect(201);
      await api().post('/api/blacklist').set(ADMIN).send(entryInput({ registerNo: 'УБ22222222' })).expect(201);

      const ok = await api().patch(`/api/blacklist/${a.body.id}`).set(ADMIN).send({ name: 'Засагдсан', isActive: false }).expect(200);
      expect(ok.body).toMatchObject({ name: 'Засагдсан', isActive: false, registerNo: 'УБ11111111', listType: 'DELINQUENT' });
      await api().patch(`/api/blacklist/${a.body.id}`).set(ADMIN).send({ registerNo: 'УБ22222222' }).expect(409);
      await api().patch(`/api/blacklist/${a.body.id}`).set(ADMIN).send({ customerType: 'ROBOT' }).expect(400);
      await api().patch('/api/blacklist/nope').set(ADMIN).send({ name: 'x' }).expect(404);
    });

    it('accepts the GET response body back as a PATCH (reasonText: null round-trips) without emitting an event', async () => {
      const created = await api().post('/api/blacklist').set(ADMIN).send({ ...entryInput(), reasonText: undefined }).expect(201);
      expect(created.body.reasonText).toBeNull();

      const got = (await api().get(`/api/blacklist/${created.body.id}`).set(ADMIN).expect(200)).body;
      const patched = await api().patch(`/api/blacklist/${created.body.id}`).set(ADMIN).send(got).expect(200);

      expect(patched.body).toEqual(got);
      expect(repo.events).toHaveLength(1);
    });

    it('clears reasonText with null (and with an empty string) and does not echo a register number', async () => {
      const { body } = await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(201);
      expect(body.reasonText).toBe('Delinquent over 90 days');

      expect((await api().patch(`/api/blacklist/${body.id}`).set(ADMIN).send({ reasonText: null }).expect(200)).body.reasonText).toBeNull();
      await api().patch(`/api/blacklist/${body.id}`).set(ADMIN).send({ reasonText: 'again' }).expect(200);
      expect((await api().patch(`/api/blacklist/${body.id}`).set(ADMIN).send({ reasonText: '' }).expect(200)).body.reasonText).toBeNull();
      expect((await api().get(`/api/blacklist/${body.id}`).set(ADMIN)).body.reasonText).toBeNull();
      await api().patch(`/api/blacklist/${body.id}`).set(ADMIN).send({ reasonText: 5 }).expect(400);
    });

    it('deactivates on DELETE (never removes) and is idempotent', async () => {
      const { body } = await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(201);

      expect((await api().delete(`/api/blacklist/${body.id}`).set(ADMIN).expect(200)).body.isActive).toBe(false);
      expect((await api().delete(`/api/blacklist/${body.id}`).set(ADMIN).expect(200)).body.isActive).toBe(false);
      expect((await api().get(`/api/blacklist/${body.id}`).set(ADMIN).expect(200)).body.isActive).toBe(false);
      expect(repo.events.map((e) => e.isActive)).toEqual([true, false]);
      await api().delete('/api/blacklist/nope').set(ADMIN).expect(404);
    });
  });

  describe('POST /api/blacklist/import', () => {
    it('imports a text/csv body with BOM, CRLF, quoted commas and blank lines', async () => {
      const csv = `\uFEFF${CSV_HEADER}\r\nУБ11111111,INDIVIDUAL,"Бат, ""Болд""",DELINQUENT,LATE_PAYMENT,"note"\r\n\r\nУБ22222222,LEGAL_ENTITY,Ордон ХХК,,FRAUD,\r\n`;
      const res = await api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv; charset=utf-8').send(csv).expect(200);

      expect(BlacklistImportResult.parse(res.body)).toEqual({ created: 2, updated: 0, skipped: 0, errors: [] });
      const list = await api().get('/api/blacklist').set(ADMIN).expect(200);
      expect(list.body.items.map((i: { name: string }) => i.name).sort()).toEqual(['Бат, "Болд"', 'Ордон ХХК']);
      expect(repo.events).toHaveLength(2);
    });

    it('imports a semicolon-delimited CSV and reports per-row errors without aborting', async () => {
      const csv = [
        CSV_HEADER.replaceAll(',', ';'),
        'УБ11111111;INDIVIDUAL;Бат;DELINQUENT;LATE_PAYMENT;',
        'УБ22222222;ROBOT;Дорж;DELINQUENT;LATE_PAYMENT;',
        'УБ33333333;INDIVIDUAL;Сараа;DELINQUENT;LATE_PAYMENT;',
      ].join('\n');
      const res = await api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv').send(csv).expect(200);

      expect(res.body).toMatchObject({ created: 2, updated: 0, skipped: 0 });
      expect(res.body.errors).toEqual([{ row: 2, message: expect.stringContaining('customerType') }]);
      expect(JSON.stringify(res.body)).not.toContain('УБ22222222');
    });

    it('upserts: re-importing the same CSV skips every row', async () => {
      const csv = `${CSV_HEADER}\nУБ11111111,INDIVIDUAL,Бат,,LATE_PAYMENT,\nУБ22222222,INDIVIDUAL,Дорж,,LATE_PAYMENT,\n`;
      const send = () => api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv').send(csv).expect(200);
      expect((await send()).body).toMatchObject({ created: 2, skipped: 0 });
      expect((await send()).body).toMatchObject({ created: 0, updated: 0, skipped: 2 });
      expect(repo.events).toHaveLength(2);
    });

    it('imports a JSON { rows } body', async () => {
      const res = await api().post('/api/blacklist/import').set(ADMIN).send({ rows: [entryInput(), { nope: true }] }).expect(200);
      expect(res.body).toMatchObject({ created: 1, errors: [{ row: 2 }] });
    });

    it('answers 400 for a CSV without a usable header and for a JSON body without rows', async () => {
      const csv = (body: string) => api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv').send(body);
      expect((await csv('')).status).toBe(400);
      expect((await csv('registerNo,name\nУБ1,Бат')).body.message).toContain('Missing required column');
      expect((await csv(`${CSV_HEADER}\nУБ1,INDIVIDUAL,"unterminated`)).status).toBe(400);
      await api().post('/api/blacklist/import').set(ADMIN).send({}).expect(400);
      await api().post('/api/blacklist/import').set(ADMIN).send({ rows: 'x' }).expect(400);
    });

    it('answers 413 for more than 5000 rows', async () => {
      const rows = Array.from({ length: 5001 }, (_, i) => `УБ${String(i).padStart(8, '0')},INDIVIDUAL,N,,C,`).join('\n');
      await api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv').send(`${CSV_HEADER}\n${rows}`).expect(413);
      expect(repo.events).toHaveLength(0);
    });

    it('accepts a CSV body up to 5 MB and answers 413 above it', async () => {
      const csvOfSize = (bytes: number) => CSV_HEADER + '\n'.repeat(bytes - CSV_HEADER.length);
      const ok = await api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv').send(csvOfSize(FIVE_MB)).expect(200);
      expect(ok.body).toEqual({ created: 0, updated: 0, skipped: 0, errors: [] });
      await api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv').send(csvOfSize(FIVE_MB + 1)).expect(413);
    });
  });
  // [32]/[22] NUL (U+0000) Postgres-д хадгалагдахгүй → 500 биш 400.
  describe('NUL characters', () => {
    it('rejects NUL in a JSON body (create and patch) with 400 and writes nothing', async () => {
      const created = await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(201);
      const res = await api().post('/api/blacklist').set(ADMIN).send(entryInput({ registerNo: 'УБ99999999', name: 'Бат\u0000Болд' })).expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, message: 'Validation failed' });
      expect(res.body.issues[0].path).toEqual(['name']);
      expect(JSON.stringify(res.body)).not.toContain('УБ99999999');
      await api().patch(`/api/blacklist/${created.body.id}`).set(ADMIN).send({ reasonText: 'x\u0000y' }).expect(400);
      await api().patch(`/api/blacklist/${created.body.id}`).set(ADMIN).send({ 'na\u0000me': 'x' }).expect(400);
      expect(repo.events).toHaveLength(1);
    });

    it('rejects NUL in the query string and in the :id path parameter of every route', async () => {
      const { body } = await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(201);
      await api().get('/api/blacklist').query('q=%00').set(ADMIN).expect(400);
      await api().get('/api/blacklist').query('listType=A%00B').set(ADMIN).expect(400);
      await api().get('/api/blacklist/%00').set(ADMIN).expect(400);
      await api().get(`/api/blacklist/${body.id}%00`).set(ADMIN).expect(400);
      await api().patch('/api/blacklist/%00').set(ADMIN).send({ name: 'x' }).expect(400);
      await api().delete('/api/blacklist/%00').set(ADMIN).expect(400);
      expect((await api().get('/api/blacklist/missing').set(ADMIN)).status).toBe(404);
    });

    it('rejects a JSON import with a NUL in any row (400, nothing imported)', async () => {
      const rows = [entryInput({ registerNo: 'УБ11111111' }), entryInput({ registerNo: 'УБ22222222', name: 'a\u0000b' })];
      await api().post('/api/blacklist/import').set(ADMIN).send({ rows }).expect(400);
      expect(repo.events).toHaveLength(0);
    });

    it('rejects a CSV import containing NUL (e.g. a UTF-16 file) with 400 before importing any row', async () => {
      const csv = `${CSV_HEADER}\nУБ11111111,INDIVIDUAL,Бат,,LATE_PAYMENT,\nУБ22222222,INDIVIDUAL,Дорж\u0000,,LATE_PAYMENT,\n`;
      const res = await api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv').send(csv).expect(400);
      expect(JSON.stringify(res.body)).toContain('UTF-8');
      expect(repo.events).toHaveLength(0);
    });
  });

  // [27] Windows-1251 / UTF-16 CSV чимээгүй U+FFFD болж хадгалагдаж (kyc-д хэзээ ч таарахгүй) болохгүй.
  describe('CSV charset', () => {
    const post = (body: Buffer | string, contentType = 'text/csv; charset=utf-8') => api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', contentType).send(body);

    it('rejects a Windows-1251 encoded CSV with 400 that names the UTF-8 requirement, and imports nothing', async () => {
      const csv = cp1251(`${CSV_HEADER}\nУБ16161616,INDIVIDUAL,Бат Болд,,LATE_PAYMENT,\n`);
      const res = await post(csv, 'text/csv; charset=windows-1251');
      expect(res.status).toBe(400);
      expect(res.body.message).toContain('UTF-8');
      expect(repo.events).toHaveLength(0);
      expect((await api().get('/api/blacklist').set(ADMIN)).body.total).toBe(0);
    });

    it('rejects a UTF-16LE CSV (with BOM) with 400', async () => {
      const res = await post(Buffer.from(`\uFEFF${CSV_HEADER}\nУБ1,INDIVIDUAL,Бат,,LATE,\n`, 'utf16le'));
      expect(res.status).toBe(400);
      expect(repo.events).toHaveLength(0);
    });

    it('rejects a truncated multi-byte sequence', async () => {
      const bytes = Buffer.concat([Buffer.from(`${CSV_HEADER}\nУБ1,INDIVIDUAL,Бат`, 'utf8'), Buffer.from([0xd0])]);
      expect((await post(bytes)).status).toBe(400);
    });

    it('still imports valid UTF-8 Cyrillic, with and without a BOM, storing the decoded text', async () => {
      const csv = `${CSV_HEADER}\nУБ11111111,INDIVIDUAL,Бат Болд,,LATE_PAYMENT,\n`;
      const withBom = await post(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, 'utf8')]));
      expect(withBom.body).toEqual({ created: 1, updated: 0, skipped: 0, errors: [] });
      const plain = await post(Buffer.from(csv.replace('УБ11111111', 'УБ22222222'), 'utf8'));
      expect(plain.body).toMatchObject({ created: 1 });
      const names = (await api().get('/api/blacklist').set(ADMIN)).body.items.map((i: { name: string; registerNo: string }) => `${i.registerNo}:${i.name}`).sort();
      expect(names).toEqual(['УБ11111111:Бат Болд', 'УБ22222222:Бат Болд']);
      expect(JSON.stringify(names)).not.toContain('\uFFFD');
    });
  });

  // [18]/[31] csv-body.middleware нь guard-аас өмнө ажилладаг: нэвтрэлт/дүр/хэмжээг body-г уншихаас ӨМНӨ шалгана.
  describe('CSV import is authorised and size-checked before the body is read', () => {
    const listen = async () => {
      await app.listen(0, '127.0.0.1');
      return (app.getHttpServer().address() as AddressInfo).port;
    };
    const declared = (headers: Record<string, string>, length = FIVE_MB) => csvHead({ ...headers, 'Content-Length': String(length) });
    const raw = (h: Record<string, string>) => ({ 'X-User-Id': 'user-1', 'X-Org-Id': 'org-1', 'X-Roles': 'ADMIN', ...h });

    it.each([
      ['no X-User-Id', 401, { 'X-Org-Id': 'org-1', 'X-Roles': 'ADMIN' }],
      ['OFFICER', 403, raw({ 'X-Roles': 'OFFICER' })],
      ['no roles', 403, raw({ 'X-Roles': '' })],
      ['unknown role', 403, raw({ 'X-Roles': 'BOGUS' })],
      ['no X-Org-Id (DEFAULT_ORG_ID unset)', 400, { 'X-User-Id': 'user-1', 'X-Roles': 'ADMIN' }],
    ])('answers %s with %i immediately, without waiting for a 5 MB body, and closes the connection', async (_label, status, headers) => {
      const port = await listen();
      // Body огт илгээхгүй: хуучин код 5 MB-ийг хүлээн унших гэж өлгөөтэй үлддэг байв.
      const res = await rawRequest(port, declared(headers));
      expect(res).toEqual({ status, closed: true });
    });

    it('answers 413 from Content-Length alone (no body sent) and closes the connection', async () => {
      const port = await listen();
      expect(await rawRequest(port, declared(raw({}), FIVE_MB + 1))).toEqual({ status: 413, closed: true });
      expect(await rawRequest(port, declared(raw({}), 50 * FIVE_MB))).toEqual({ status: 413, closed: true });
    });

    it('checks the role before the size: an oversize body from a forbidden caller is 403, from an anonymous caller 401', async () => {
      const port = await listen();
      expect((await rawRequest(port, declared(raw({ 'X-Roles': 'OFFICER' }), FIVE_MB + 1))).status).toBe(403);
      expect((await rawRequest(port, declared({ 'X-Org-Id': 'org-1' }, FIVE_MB + 1))).status).toBe(401);
    });

    it('stops accepting a chunked stream once the cap is exceeded: 413 and the connection is closed, not drained', async () => {
      const port = await listen();
      const res = await streamChunked(port, raw({}), 64 * 1024 * 1024);
      expect(res.status).toBe(413);
      expect(res.closed).toBe(true);
      // Сервер дуустал нь уншдаг (drain) байсан бол 64 MB бүгд явна; socket-ийн буфер (~10 MB) хүртэл л зөвшөөрнө.
      expect(res.sent).toBeLessThan(32 * 1024 * 1024);
    });

    it('does not read an unauthenticated or forbidden chunked stream at all', async () => {
      const port = await listen();
      const anon = await streamChunked(port, { 'X-Org-Id': 'org-1' }, 64 * 1024 * 1024);
      const officer = await streamChunked(port, raw({ 'X-Roles': 'OFFICER' }), 64 * 1024 * 1024);
      expect([anon.status, officer.status]).toEqual([401, 403]);
      expect(anon.sent).toBeLessThan(32 * 1024 * 1024);
      expect(officer.sent).toBeLessThan(32 * 1024 * 1024);
      expect(repo.events).toHaveLength(0);
    });

    it('answers an oversize body from an anonymous or forbidden caller with 401 / 403, not 413', async () => {
      const big = 'x'.repeat(FIVE_MB + 1);
      await api().post('/api/blacklist/import').set({ 'X-Org-Id': 'org-1', 'X-Roles': 'ADMIN' }).set('Content-Type', 'text/csv').send(big).expect(401);
      await api().post('/api/blacklist/import').set(as('OFFICER')).set('Content-Type', 'text/csv').send(big).expect(403);
    });

    it('rejects 5 MB of "a\\n" lines with 413 quickly (row limit applies while parsing) and imports nothing', async () => {
      const lines = 'a\n'.repeat(FIVE_MB / 2);
      const heapBefore = process.memoryUsage().heapUsed;
      const t = Date.now();
      await api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv').send(lines).expect(413);
      expect(Date.now() - t).toBeLessThan(1000);
      expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(150 * 1024 * 1024);
      expect(repo.events).toHaveLength(0);
    });

    it('still serves a normal import on a fresh connection after rejected ones', async () => {
      const port = await listen();
      await rawRequest(port, declared(raw({ 'X-Roles': 'OFFICER' })));
      const res = await api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv').send(`${CSV_HEADER}\nУБ11111111,INDIVIDUAL,Бат,,LATE_PAYMENT,\n`).expect(200);
      expect(res.body.created).toBe(1);
    });
  });

  describe('PATCH registerNo content guard', () => {
    it.each([['only separators', '---'], ['a zero-width space', '\u200B'], ['blank after trim', '   '], ['dots and slashes', '.,/_'], ['only unsupported symbols', '???']])(
      'rejects a register that is %s with 400, keeping the stored register and emitting no event',
      async (_label, registerNo) => {
        const { body } = await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(201);

        const res = await api().patch(`/api/blacklist/${body.id}`).set(ADMIN).send({ registerNo }).expect(400);

        expect(res.body.issues.map((i: { path: string[] }) => i.path[0])).toContain('registerNo');
        expect((await api().get(`/api/blacklist/${body.id}`).set(ADMIN)).body.registerNo).toBe(REGISTER);
        expect(repo.events).toHaveLength(1);
        // Нормчлогдоод хоосон болсон регистр HMAC('')-д хадгалагдаж, ийм бүх регистрт таардаг болох байсан.
        expect(await repo.findByKey('org-1', hashRegisterNo(''), 'DELINQUENT')).toBeNull();
      },
    );

    it('rejects unsupported characters in a PATCH register but accepts separators and stores the normalised form', async () => {
      const { body } = await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(201);
      await api().patch(`/api/blacklist/${body.id}`).set(ADMIN).send({ registerNo: 'УБ9999?999' }).expect(400);
      await api().patch(`/api/blacklist/${body.id}`).set(ADMIN).send({ registerNo: '\uFFFD\uFFFD99999999' }).expect(400);

      const ok = await api().patch(`/api/blacklist/${body.id}`).set(ADMIN).send({ registerNo: 'уб-9999 9999' }).expect(200);
      expect(ok.body.registerNo).toBe('УБ99999999');
      expect(repo.events).toHaveLength(2);
    });
  });

  // Нормчлогч үсэг/цифр биш тэмдэгтийг (?, U+FFFD, ...) чимээгүй хаядаг: "УБ1234?678" нь hash('УБ1234678') болж, жинхэнэ
  // регистртэй хэзээ ч таарахгүй (kyc-д хуурамч CLEAR). Тусгаарлагч (space - _ . / ,) нь алдагдал биш.
  describe('unsupported characters in a register number', () => {
    it('reports a row error for such CSV rows, imports the rest, and stores separator-bearing registers normalised', async () => {
      const csv = [
        CSV_HEADER,
        'УБ11111111,INDIVIDUAL,Бат,,LATE_PAYMENT,',
        'УБ1234?678,INDIVIDUAL,Дорж,,LATE_PAYMENT,',
        '??22222222,INDIVIDUAL,Сараа,,LATE_PAYMENT,',
        'уб-333 33333,INDIVIDUAL,Болд,,LATE_PAYMENT,',
        '"УБ,4444.4444",INDIVIDUAL,Нара,,LATE_PAYMENT,',
        'УБ5555/5555,INDIVIDUAL,Тэмүүлэн,,LATE_PAYMENT,',
        'УБ(66666666),INDIVIDUAL,Ану,,LATE_PAYMENT,',
      ].join('\n');
      const res = await api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv').send(csv).expect(200);

      expect(res.body).toEqual({
        created: 4, updated: 0, skipped: 0,
        errors: [
          { row: 2, message: 'registerNo: registerNo contains unsupported characters' },
          { row: 3, message: 'registerNo: registerNo contains unsupported characters' },
          { row: 7, message: 'registerNo: registerNo contains unsupported characters' },
        ],
      });
      const stored = (await api().get('/api/blacklist').set(ADMIN)).body.items.map((i: { registerNo: string }) => i.registerNo).sort();
      expect(stored).toEqual(['УБ11111111', 'УБ33333333', 'УБ44444444', 'УБ55555555']);
      expect(repo.events).toHaveLength(4);
    });

    it('reports the same row error for JSON import rows', async () => {
      const rows = [entryInput({ registerNo: 'УБ1234?678' }), entryInput({ registerNo: 'УБ87654321' })];
      const res = await api().post('/api/blacklist/import').set(ADMIN).send({ rows }).expect(200);
      expect(res.body).toEqual({ created: 1, updated: 0, skipped: 0, errors: [{ row: 1, message: 'registerNo: registerNo contains unsupported characters' }] });
    });

    it('answers 400 with a custom issue on the registerNo path for POST, and writes nothing', async () => {
      const res = await api().post('/api/blacklist').set(ADMIN).send(entryInput({ registerNo: 'УБ1234?678' })).expect(400);
      expect(res.body.issues).toEqual([{ code: 'custom', path: ['registerNo'], message: 'registerNo contains unsupported characters' }]);
      expect(repo.events).toHaveLength(0);
    });
  });

  // Windows-1251 CSV-г Excel/засварлагч U+FFFD болгон хөрвүүлж UTF-8-ээр хадгалсан бол байт нь зөв UTF-8: хатуу декодер өнгөрүүлнэ.
  describe('replacement characters (U+FFFD) and lone surrogates', () => {
    const csvPost = (body: Buffer | string) => api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv; charset=utf-8').send(body);

    it('rejects a valid-UTF-8 CSV that contains U+FFFD with the UTF-8 hint and imports nothing', async () => {
      const csv = `${CSV_HEADER}\n\uFFFD\uFFFD12345678,INDIVIDUAL,\uFFFD\uFFFD\uFFFD,,LATE,\n`;
      const res = await csvPost(Buffer.from(csv, 'utf8')).expect(400);

      expect(res.body.message).toContain('valid UTF-8');
      expect(res.body.message).toContain('"CSV UTF-8"');
      expect(repo.events).toHaveLength(0);
      expect((await api().get('/api/blacklist').set(ADMIN)).body.total).toBe(0);
    });

    it('rejects U+FFFD anywhere in an otherwise good CSV (data row after valid rows), with nothing imported', async () => {
      const csv = `${CSV_HEADER}\nУБ11111111,INDIVIDUAL,Бат,,LATE,\nУБ22222222,INDIVIDUAL,До\uFFFDж,,LATE,\n`;
      await csvPost(Buffer.from(csv, 'utf8')).expect(400);
      expect(repo.events).toHaveLength(0);
    });

    it('rejects U+FFFD in JSON bodies: POST, PATCH, import rows and object keys', async () => {
      const created = await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(201);

      const post = await api().post('/api/blacklist').set(ADMIN).send(entryInput({ registerNo: 'УБ99999999', name: 'Бат\uFFFDБолд' })).expect(400);
      expect(post.body).toMatchObject({ statusCode: 400, message: 'Validation failed' });
      expect(post.body.issues).toEqual([{ code: 'custom', path: ['name'], message: expect.stringContaining('U+FFFD') }]);
      expect(JSON.stringify(post.body)).not.toMatch(/\uFFFD|УБ99999999|Бат/);

      await api().post('/api/blacklist').set(ADMIN).send(entryInput({ registerNo: '\uFFFD\uFFFD12345678' })).expect(400);
      await api().patch(`/api/blacklist/${created.body.id}`).set(ADMIN).send({ reasonText: 'x\uFFFDy' }).expect(400);
      await api().patch(`/api/blacklist/${created.body.id}`).set(ADMIN).send({ 'na\uFFFDme': 'x' }).expect(400);
      const rows = [entryInput({ registerNo: 'УБ11111111' }), entryInput({ registerNo: 'УБ22222222', name: 'Дорж\uFFFD' })];
      await api().post('/api/blacklist/import').set(ADMIN).send({ rows }).expect(400);

      expect(repo.events).toHaveLength(1);
    });

    it('rejects U+FFFD in a query string and in an :id path parameter', async () => {
      await api().get('/api/blacklist').query('q=%EF%BF%BD').set(ADMIN).expect(400);
      await api().get('/api/blacklist/%EF%BF%BD').set(ADMIN).expect(400);
    });

    it.each([
      ['a trailing high surrogate', { name: 'Бат\ud800' }],
      ['a lone low surrogate', { reasonText: '\udc00' }],
      ['a high surrogate followed by a letter', { name: 'a\ud83dz' }],
      ['a lone surrogate in the register', { registerNo: 'УБ1234\ud8005678' }],
      ['a lone surrogate in an unknown key', { 'extra\ud800': 'x' }],
    ])('rejects %s in POST and PATCH with 400 (not a 500 from the database layer) and echoes nothing', async (_label, patch) => {
      const created = await api().post('/api/blacklist').set(ADMIN).send(entryInput()).expect(201);

      const post = await api().post('/api/blacklist').set(ADMIN).send(entryInput({ registerNo: 'УБ77777777', ...patch })).expect(400);
      expect(post.body).toMatchObject({ statusCode: 400, message: 'Validation failed' });
      expect(post.body.issues[0]).toMatchObject({ code: 'custom', message: expect.stringContaining('lone surrogate') });
      await api().patch(`/api/blacklist/${created.body.id}`).set(ADMIN).send(patch).expect(400);

      expect(JSON.stringify(post.body)).not.toMatch(/Бат|УБ77777777/);
      expect(logs.filter((l) => l.level === 'error')).toEqual([]);
      expect(repo.events).toHaveLength(1);
    });

    it('rejects a lone surrogate in a JSON import row as a 400 for the whole body, importing nothing', async () => {
      const rows = [entryInput({ registerNo: 'УБ11111111' }), entryInput({ registerNo: 'УБ22222222', name: 'Дорж\ud800' })];
      const res = await api().post('/api/blacklist/import').set(ADMIN).send({ rows }).expect(400);
      expect(res.body.issues).toEqual([{ code: 'custom', path: ['rows', 1, 'name'], message: expect.stringContaining('lone surrogate') }]);
      expect(repo.events).toHaveLength(0);
      expect(logs.filter((l) => l.level === 'error')).toEqual([]);
    });

    it('still accepts a well-formed surrogate pair (emoji) in a name', async () => {
      const res = await api().post('/api/blacklist').set(ADMIN).send(entryInput({ name: 'Бат 😀' })).expect(201);
      expect((await api().get(`/api/blacklist/${res.body.id}`).set(ADMIN)).body.name).toBe('Бат 😀');
    });
  });

  // CLAUDE.md 6.5: регистр хариу болон лог-д гарахгүй. Алдааны мессеж хүсэлтийн утгыг (header нүд, enum-д орсон регистр) echo хийхгүй.
  describe('errors never echo request data', () => {
    const csvPost = (body: string) => api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv').send(body);
    const expectNoLeak = (...texts: string[]) => {
      const seen = `${texts.join('\n')}\n${logText()}`;
      expect(seen).not.toContain('УБ12345678');
      expect(seen).not.toContain('Бат Болд');
      expect(seen).not.toContain('received');
    };

    it('a CSV without a header row: 400 with only the count and the allowed column names', async () => {
      const res = await csvPost('УБ12345678,INDIVIDUAL,Бат Болд,DELINQUENT,LATE_PAYMENT\n').expect(400);

      expect(res.body.message).toBe('5 unknown column(s) in the header row; allowed columns: registerNo, customerType, name, listType, reasonCode, reasonText');
      expectNoLeak(JSON.stringify(res.body));
      expect(repo.events).toHaveLength(0);
    });

    it('an unknown header cell that looks like a register is not echoed either', async () => {
      const res = await csvPost(`${CSV_HEADER},УБ12345678\nУБ11111111,INDIVIDUAL,Бат,,LATE,,\n`).expect(400);
      expect(res.body.message).toMatch(/^1 unknown column\(s\)/);
      expectNoLeak(JSON.stringify(res.body));
    });

    it('a register in the customerType cell (shifted columns): CSV row error without the value', async () => {
      const res = await csvPost(`${CSV_HEADER}\nINDIVIDUAL,УБ12345678,Бат Болд,,LATE,\nУБ22222222,INDIVIDUAL,Дорж,,LATE,\n`).expect(200);

      expect(res.body.created).toBe(1);
      expect(res.body.errors).toHaveLength(1);
      expect(res.body.errors[0].row).toBe(1);
      expect(res.body.errors[0].message).toContain("customerType: Invalid enum value. Expected 'INDIVIDUAL' | 'LEGAL_ENTITY'");
      expectNoLeak(JSON.stringify(res.body));
    });

    it('the same for a JSON import row and for POST/PATCH (400 issues carry no `received`, no value)', async () => {
      const bad = entryInput({ customerType: REGISTER, name: 'Бат Болд' });
      const imported = await api().post('/api/blacklist/import').set(ADMIN).send({ rows: [bad] }).expect(200);
      const post = await api().post('/api/blacklist').set(ADMIN).send(bad).expect(400);
      const created = await api().post('/api/blacklist').set(ADMIN).send(entryInput({ registerNo: 'УБ22222222' })).expect(201);
      const patch = await api().patch(`/api/blacklist/${created.body.id}`).set(ADMIN).send({ customerType: REGISTER, name: 5 }).expect(400);

      expectNoLeak(JSON.stringify(imported.body), JSON.stringify(post.body), JSON.stringify(patch.body));
      expect(post.body.issues).toEqual([
        { code: 'invalid_enum_value', path: ['customerType'], message: "Invalid enum value. Expected 'INDIVIDUAL' | 'LEGAL_ENTITY'", options: ['INDIVIDUAL', 'LEGAL_ENTITY'] },
      ]);
      expect(patch.body.issues.find((i: { path: string[] }) => i.path[0] === 'name')).toEqual({ code: 'invalid_type', path: ['name'], message: 'Expected string', expected: 'string' });
    });

    it('wrong types and missing fields keep a helpful message but no value', async () => {
      const res = await api().post('/api/blacklist').set(ADMIN).send({ registerNo: 12345678, customerType: 'INDIVIDUAL', reasonCode: 'lower case УБ12345678' }).expect(400);

      const byPath = Object.fromEntries(res.body.issues.map((i: { path: string[]; message: string }) => [i.path[0], i.message]));
      expect(byPath.registerNo).toBe('Expected string');
      expect(byPath.name).toBe('Required');
      expectNoLeak(JSON.stringify(res.body));
    });
  });

  // Бодит TCP socket: FakeRequest.destroy() 'error' emit хийдэггүй тул middleware-ийн unit тест Node-ийн бодит замыг (req.destroy(ECONNRESET 'aborted'))
  // хардаггүй байв. Клиент body дундаа таслахад тод 400 'Request body was aborted' ба ERROR лог (stack) байхгүй.
  describe('a client that aborts mid-upload', () => {
    let ends: Array<{ status: number; body: string }>;

    beforeEach(() => {
      ends = [];
      // Нийт хариуг (statusCode, body) серверийн талд барина: клиент socket-ээ хаасан тул хариуг клиент уншиж чадахгүй.
      app.getHttpServer().prependListener('request', (_req: unknown, res: { statusCode: number; end: (...a: unknown[]) => unknown }) => {
        const end = res.end.bind(res);
        res.end = (...a: unknown[]) => {
          ends.push({ status: res.statusCode, body: typeof a[0] === 'string' || Buffer.isBuffer(a[0]) ? String(a[0]) : '' });
          return end(...a);
        };
      });
    });

    const abortUpload = (port: number, how: 'fin' | 'destroy' | 'reset', headers: Record<string, string>) => new Promise<void>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => {
        // Content-Length 5000 гэж амлаад ~60 байт л илгээнэ.
        socket.write(`${csvHead({ ...headers, 'Content-Length': '5000' })}${CSV_HEADER}\nУБ11111111,INDIVIDUAL,Ба`);
        setTimeout(() => {
          if (how === 'reset') socket.resetAndDestroy();
          else if (how === 'fin') socket.end();
          else socket.destroy();
        }, 80);
      });
      socket.on('error', () => undefined);
      socket.on('close', () => resolve());
      socket.resume(); // сервер хариу (400) болон FIN илгээнэ: уншихгүй бол 'close' ирэхгүй
    });
    const headers = { 'X-User-Id': 'user-1', 'X-Org-Id': 'org-1', 'X-Roles': 'ADMIN' };
    const waitForResponse = async () => {
      for (let i = 0; i < 100 && ends.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    };

    it.each([['closes with FIN after a partial body', 'fin'], ['destroys the socket', 'destroy'], ['resets the connection (RST)', 'reset']] as const)(
      'answers a quiet 400 (no ERROR log, nothing imported) when the client %s',
      async (_label, how) => {
        await app.listen(0, '127.0.0.1');
        const { port } = app.getHttpServer().address() as AddressInfo;

        await abortUpload(port, how, headers);
        await waitForResponse();

        expect(ends).toHaveLength(1);
        expect(ends[0].status).toBe(400);
        expect(ends[0].body).toContain('Request body was aborted');
        expect(logs.filter((l) => l.level === 'error')).toEqual([]);
        expect(repo.events).toHaveLength(0);
        // Сервер дараагийн хүсэлтийг хэвийн хүлээн авна.
        await csvPostOk();
      },
    );

    const csvPostOk = async () => {
      const res = await api().post('/api/blacklist/import').set(ADMIN).set('Content-Type', 'text/csv').send(`${CSV_HEADER}\nУБ22222222,INDIVIDUAL,Дорж,,LATE_PAYMENT,\n`).expect(200);
      expect(res.body.created).toBe(1);
    };
  });

});
