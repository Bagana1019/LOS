import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import request from 'supertest';
import type { OrgDirectory } from '@los/contracts';
import { createTestApp, TestApp } from '../../test-utils/test-app';
import { actors, BRANCH, hasTestDb, resetDb } from '../../test-utils/factories';
import { ORG_DIRECTORY_SOURCE, ORG_DIRECTORY_TTL_MS, type OrgDirectorySource } from '../../shared/org-directory';
import { ApplicationModule } from './application.module';

// FR-1.3: хүсэлтийн Excel экспортод салбар / ЗЭЗ нь UUID биш нэрээр гарна. Нэр gateway-ийн лавлахаас (origination өөр schema уншихгүй).
describe.skipIf(!hasTestDb)('application export: салбар/ЗЭЗ-ийн нэр (DB)', () => {
  let t: TestApp;
  const officer = actors.officer('officer-a');
  const names: { value: OrgDirectory | Error } = { value: { branches: { [BRANCH]: 'Төв салбар' }, users: { 'officer-a': 'Бат Болд' } } };
  const source: OrgDirectorySource & { fetch: ReturnType<typeof vi.fn> } = {
    fetch: vi.fn(async () => { if (names.value instanceof Error) throw names.value; return names.value; }),
  };
  let warn: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => { t = await createTestApp([ApplicationModule], (b) => b.overrideProvider(ORG_DIRECTORY_SOURCE).useValue(source)); });
  afterAll(async () => { await t.close(); });
  beforeEach(async () => {
    await resetDb(t.prisma);
    t.clock.set(new Date(t.clock.now().getTime() + ORG_DIRECTORY_TTL_MS + 1)); // тест бүр лавлахын кэшийг хуучруулж шинээр авна
    source.fetch.mockClear();
    names.value = { branches: { [BRANCH]: 'Төв салбар' }, users: { 'officer-a': 'Бат Болд' } };
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => { warn.mockRestore(); });

  async function createApps(n: number): Promise<void> {
    for (let i = 0; i < n; i++) expect((await request(t.app.getHttpServer()).post('/api/applications').set(officer).send({})).status).toBe(201);
  }
  async function exported(as: Record<string, string> = officer): Promise<string[][]> {
    const res = await request(t.app.getHttpServer()).get('/api/applications/export').set(as).buffer(true)
      .parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const head = ws.getRow(1);
    const at = (label: string) => { for (let c = 1; c <= ws.columnCount; c++) if (head.getCell(c).value === label) return c; throw new Error(`no column ${label}`); };
    const [branch, who] = [at('Салбар'), at('Хариуцсан ЗЭЗ')];
    const out: string[][] = [];
    for (let r = 2; r <= ws.rowCount; r++) out.push([String(ws.getRow(r).getCell(branch).value), String(ws.getRow(r).getCell(who).value)]);
    return out;
  }

  it('салбарын нэр, ЗЭЗ-ийн бүтэн нэр гарна (UUID биш)', async () => {
    await createApps(1);
    expect(await exported()).toEqual([['Төв салбар', 'Бат Болд']]);
  });

  it('лавлахад байхгүй id → id хэвээр; ЗЭЗ-гүй хүсэлт → "Систем"', async () => {
    await createApps(2);
    const [a] = await t.prisma.loanApplication.findMany({ orderBy: { appNo: 'asc' }, take: 1 });
    await t.prisma.loanApplication.update({ where: { id: a!.id }, data: { officerId: null } });
    names.value = { branches: {}, users: {} };
    const rows = await exported(actors.admin()); // ЗЭЗ-ийн хүрээнээс гадуур тул ADMIN
    expect(rows).toContainEqual([BRANCH, 'Систем']);
    expect(rows).toContainEqual([BRANCH, 'officer-a']);
  });

  it('лавлах унавал экспорт 200 (id-тай), warning лог', async () => {
    await createApps(1);
    names.value = new Error('gateway сервис руу холбогдож чадсангүй');
    expect(await exported()).toEqual([[BRANCH, 'officer-a']]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('batch: 3 хүсэлт → лавлахыг нэг л удаа дуудна; хүсэлт байхгүй бол огт дуудахгүй', async () => {
    expect(await exported()).toEqual([]);
    expect(source.fetch).not.toHaveBeenCalled();
    await createApps(3);
    await exported();
    expect(source.fetch).toHaveBeenCalledTimes(1);
  });
});
