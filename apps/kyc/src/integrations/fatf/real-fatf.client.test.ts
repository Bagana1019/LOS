import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExternalListError, IntegrationNotConfiguredError } from '../errors';
import { parseFatfList } from './fatf-list';
import { assertFatfProductionConfig, loadFatfConfig } from './fatf.config';
import { RealFatfClient } from './real-fatf.client';

// Hermetic: FATF_LIST_FILE-ийг түр хавтсанд бичнэ. Өгөгдөл бүхэлдээ синтетик (албан ёсны жагсаалт БИШ).
const entry = (over: Record<string, unknown> = {}) => ({ countryCode: 'KP', countryName: "Korea, Democratic People's Republic of", category: 'CALL_FOR_ACTION', listedOn: '2026-10-23', ...over });
const list = (over: Record<string, unknown> = {}) => ({
  version: '2026-10', publishedAt: '2026-10-24',
  entries: [entry(), entry({ countryCode: 'IR', countryName: 'Iran' }), entry({ countryCode: 'KE', countryName: 'Kenya', category: 'INCREASED_MONITORING', listedOn: '2026-02-20' })],
  ...over,
});

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fatf-test-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
let n = 0;
const file = (content: unknown, raw = false): string => {
  const p = join(dir, `list-${n++}.json`);
  writeFileSync(p, raw ? String(content) : JSON.stringify(content));
  return p;
};
const clientFor = (path: string | undefined) => new RealFatfClient({ env: path === undefined ? {} : { FATF_LIST_FILE: path } });
const reasonOf = async (p: Promise<unknown>): Promise<Error> => {
  try { await p; } catch (e) { return e as Error; }
  throw new Error('expected a rejection');
};

describe('RealFatfClient — файлаас унших', () => {
  it('зөв файл → snapshot: version = plenary сар, publishedAt = ISO, бичлэгүүд хэвээр', async () => {
    const snap = await clientFor(file(list())).fetchSnapshot();
    expect(snap.version).toBe('2026-10');
    expect(snap.publishedAt).toBe('2026-10-24T00:00:00.000Z');
    expect(snap.entries).toEqual(list().entries);
  });

  it('publishedAt datetime (оффсеттэй) → UTC ISO болгоно', async () => {
    const snap = await clientFor(file(list({ publishedAt: '2026-10-24T09:30:00+08:00' }))).fetchSnapshot();
    expect(snap.publishedAt).toBe('2026-10-24T01:30:00.000Z');
  });

  it('FATF_LIST_FILE тохируулаагүй → IntegrationNotConfiguredError (нэрийг л заана)', async () => {
    const err = await reasonOf(clientFor(undefined).fetchSnapshot());
    expect(err).toBeInstanceOf(IntegrationNotConfiguredError);
    expect((err as IntegrationNotConfiguredError).missing).toEqual(['FATF_LIST_FILE']);
  });

  it('файл олдохгүй → "unreadable"; алдаанд зам оруулахгүй', async () => {
    const missing = join(dir, 'nope-' + 'x'.repeat(8) + '.json');
    const err = await reasonOf(clientFor(missing).fetchSnapshot());
    expect(err).toBeInstanceOf(ExternalListError);
    expect(err.message).toMatch(/FATF_LIST_FILE.*unreadable/);
    expect(err.message).not.toContain('nope-');
  });

  it('хавтас (энгийн файл биш) → "unreadable"', async () => {
    const d = join(dir, 'adir');
    mkdirSync(d);
    await expect(clientFor(d).fetchSnapshot()).rejects.toThrow(/unreadable/);
  });

  it('хэт том файл (>256 KiB) → татгалзана', async () => {
    await expect(clientFor(file('x'.repeat(300 * 1024), true)).fetchSnapshot()).rejects.toThrow(/too large/i);
  });

  it('JSON биш → татгалзана; алдаа файлын агуулгыг оруулахгүй', async () => {
    const err = await reasonOf(clientFor(file('{"version": SECRETBODY', true)).fetchSnapshot());
    expect(err).toBeInstanceOf(ExternalListError);
    expect(err.message).toMatch(/not valid JSON/i);
    expect(err.message).not.toContain('SECRETBODY');
  });

  it('abort хийсэн signal → уншихгүйгээр "aborted"', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(clientFor(file(list())).fetchSnapshot(ac.signal)).rejects.toThrow(/aborted/i);
  });
});

describe('parseFatfList — хатуу шалгалт (fail closed: буруу файл чимээгүй хэсэгчлэн хүлээн авагдахгүй)', () => {
  const bad: Array<[string, unknown]> = [
    ['root-д үл мэдэгдэх талбар', list({ extra: 1 })],
    ['бичлэгт үл мэдэгдэх талбар', list({ entries: [entry({ note: 'x' })] })],
    ['version буруу формат (2026)', list({ version: '2026' })],
    ['version буруу сар (2026-13)', list({ version: '2026-13' })],
    ['publishedAt буруу', list({ publishedAt: 'yesterday' })],
    ['publishedAt байхгүй огноо (2026-02-30)', list({ publishedAt: '2026-02-30' })],
    ['entries хоосон', list({ entries: [] })],
    ['entries 100-аас олон', list({ entries: Array.from({ length: 101 }, (_, i) => entry({ countryCode: `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}` })) })],
    ['countryCode жижиг үсэг', list({ entries: [entry({ countryCode: 'kp' })] })],
    ['countryCode 3 үсэг', list({ entries: [entry({ countryCode: 'PRK' })] })],
    ['countryName хоосон', list({ entries: [entry({ countryName: '  ' })] })],
    ['category буруу', list({ entries: [entry({ category: 'WATCH' })] })],
    ['listedOn буруу формат', list({ entries: [entry({ listedOn: '23/10/2026' })] })],
    ['listedOn байхгүй огноо', list({ entries: [entry({ listedOn: '2026-13-40' })] })],
    ['давхардсан countryCode (өөр category-тай ч)', list({ entries: [entry(), entry({ category: 'INCREASED_MONITORING' })] })],
    ['талбар дутуу', list({ entries: [{ countryCode: 'KP' }] })],
    ['массив биш root', []],
  ];
  it.each(bad)('%s → татгалзана', (_label, value) => {
    expect(() => parseFatfList(JSON.stringify(value))).toThrow(ExternalListError);
  });

  it('алдааны мессеж талбарын замыг заана, утгыг оруулахгүй', () => {
    try {
      parseFatfList(JSON.stringify(list({ entries: [entry({ countryCode: 'secret-value' })] })));
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).toContain('entries.0.countryCode');
      expect((e as Error).message).not.toContain('secret-value');
    }
  });

  it('хоёр category хоёулаа байж болно; 100 бичлэг хүртэл зөвшөөрнө', () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry({ countryCode: `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, category: i % 2 ? 'INCREASED_MONITORING' : 'CALL_FOR_ACTION' }));
    expect(parseFatfList(JSON.stringify(list({ entries }))).entries).toHaveLength(100);
  });

  it('UTF-8 BOM-той файлыг (Windows засварлагч) хүлээн авна', () => {
    expect(parseFatfList('﻿' + JSON.stringify(list())).entries).toHaveLength(3);
  });
});

describe('loadFatfConfig / assertFatfProductionConfig', () => {
  const prod = { NODE_ENV: 'production', INTEGRATION_MODE: 'real' };

  it('loadFatfConfig: зам (trim)', () => {
    expect(loadFatfConfig({ FATF_LIST_FILE: '  /srv/fatf.json ' })).toEqual({ listFile: '/srv/fatf.json' });
  });

  it('production + real + FATF_LIST_FILE байхгүй → эхлэхгүй (нэрийг л заана)', () => {
    let err: unknown;
    try { assertFatfProductionConfig(prod); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(IntegrationNotConfiguredError);
    expect((err as IntegrationNotConfiguredError).missing).toEqual(['FATF_LIST_FILE']);
  });

  it('production + real + файл уншигдахгүй → "(unreadable)"; агуулга буруу → "(invalid)"; зөв → OK', () => {
    const missing = (() => { try { assertFatfProductionConfig({ ...prod, FATF_LIST_FILE: join(dir, 'absent.json') }); } catch (e) { return e as IntegrationNotConfiguredError; } })();
    expect(missing?.missing).toEqual(['FATF_LIST_FILE (unreadable)']);
    const invalid = (() => { try { assertFatfProductionConfig({ ...prod, FATF_LIST_FILE: file(list({ entries: [] })) }); } catch (e) { return e as IntegrationNotConfiguredError; } })();
    expect(invalid?.missing).toEqual(['FATF_LIST_FILE (invalid)']);
    expect(() => assertFatfProductionConfig({ ...prod, FATF_LIST_FILE: file(list()) })).not.toThrow();
  });

  it('production биш эсвэл mock үед файлыг ч уншихгүй', () => {
    expect(() => assertFatfProductionConfig({ INTEGRATION_MODE: 'real', FATF_LIST_FILE: join(dir, 'absent.json') })).not.toThrow();
    expect(() => assertFatfProductionConfig({ NODE_ENV: 'production', INTEGRATION_MODE: 'mock' })).not.toThrow();
  });
});
