import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { EncumbranceSourceResult } from '@los/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationNotImplementedError } from '../errors';
import { createEncumbranceRegistry, EncumbranceIntegrationModule } from './encumbrance.module';
import { ENCUMBRANCE_ASSET_TYPES, ENCUMBRANCE_REGISTRY, EncumbranceUnavailableError, isEncumbranceAssetType } from './encumbrance.registry';
import { MOCK_ENCUMBRANCE_PLEDGEE, lastDigitOf } from './encumbrance.fixture';
import { MockEncumbranceRegistry } from './mock-encumbrance.registry';
import { RealEncumbranceRegistry } from './real-encumbrance.registry';

const registry = new MockEncumbranceRegistry();
const check = (identifier: string, assetType: (typeof ENCUMBRANCE_ASSET_TYPES)[number] = 'VEHICLE') => registry.check(assetType, identifier);
const statuses = async (identifier: string) => (await check(identifier)).map((s) => `${s.source}:${s.status}`);

describe('MockEncumbranceRegistry (DEMO rule: docs/05 §9)', () => {
  it('last digit 7 → ЗМС ENCUMBERED with the fictional pledgee, ЭБ CLEAR', async () => {
    const res = await check('УЕН5247');
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ source: 'ZMS', status: 'ENCUMBERED', pledgee: MOCK_ENCUMBRANCE_PLEDGEE });
    expect(MOCK_ENCUMBRANCE_PLEDGEE).toBe('Жишээ ББСБ');
    expect(res[0]!.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res[0]!.note).toContain('DEMO');
    expect(res[1]).toEqual({ source: 'EB', status: 'CLEAR', pledgee: null, registeredAt: null, note: null });
  });

  it('last digit 9 → ЭБ DISPUTED, ЗМС CLEAR', async () => {
    const res = await check('MOCK-УБ90010112-9', 'APARTMENT');
    expect(res[0]).toEqual({ source: 'ZMS', status: 'CLEAR', pledgee: null, registeredAt: null, note: null });
    expect(res[1]).toMatchObject({ source: 'EB', status: 'DISPUTED', pledgee: null });
    expect(res[1]!.note).toContain('DEMO');
  });

  it('anything else is CLEAR from both sources (ZMS first, then EB)', async () => {
    for (const id of ['УЕН5246', '1234УБА', '5678УНА', '7001УБЭ', '3030БАА', 'MOCK-УБ90010112-1', 'SN-00000', 'NODIGITS', '0', '8']) {
      expect(await statuses(id), id).toEqual(['ZMS:CLEAR', 'EB:CLEAR']);
    }
  });

  it('uses the LAST digit, ignoring trailing letters (5677УБА → 7), not any digit and not the last character only', async () => {
    expect(await statuses('5677УБА')).toEqual(['ZMS:ENCUMBERED', 'EB:CLEAR']);
    expect(await statuses('1239УБА')).toEqual(['ZMS:CLEAR', 'EB:DISPUTED']);
    expect(await statuses('7777УБ1')).toEqual(['ZMS:CLEAR', 'EB:CLEAR']); // 7 байгаа ч сүүлийн цифр 1
    expect(await statuses('9А7 Б')).toEqual(['ZMS:ENCUMBERED', 'EB:CLEAR']);
    expect(lastDigitOf('ABC')).toBeNull();
    expect(lastDigitOf('1234УБА')).toBe('4');
    expect(lastDigitOf('٧')).toBeNull(); // зөвхөн ASCII цифр
  });

  it('identifier ending with ERR (any case) → EncumbranceUnavailableError, even when the last digit would say 7 or 9', async () => {
    for (const id of ['ХХХERR', 'УЕН5247ERR', '5679err', 'abcErr', ' 1234ERR  ']) {
      await expect(check(id), id).rejects.toBeInstanceOf(EncumbranceUnavailableError);
    }
    expect(await statuses('ERR1')).toEqual(['ZMS:CLEAR', 'EB:CLEAR']); // төгсгөлд биш
  });

  it('is deterministic, valid per contract, and hands out fresh objects', async () => {
    const a = await check('УЕН5247');
    const b = await check('УЕН5247');
    expect(a).toEqual(b);
    for (const s of a) expect(() => EncumbranceSourceResult.parse(s)).not.toThrow();
    a[0]!.pledgee = 'Hacked';
    expect((await check('УЕН5247'))[0]!.pledgee).toBe('Жишээ ББСБ');
  });

  it('the five mock АТҮТ/ХУР vehicles are all CLEAR (so the happy path of the demo is not accidentally blocked)', async () => {
    for (const plate of ['УЕН5246', '1234УБА', '5678УНА', '7001УБЭ', '3030БАА']) expect(await statuses(plate), plate).toEqual(['ZMS:CLEAR', 'EB:CLEAR']);
  });

  it('documented coincidence: the co-owned demo property (…-9) is also DISPUTED, because its last digit is 9', async () => {
    expect(await statuses('MOCK-ЖИ00000002-9')).toEqual(['ZMS:CLEAR', 'EB:DISPUTED']);
    expect(await statuses('MOCK-ЖИ00000002-1')).toEqual(['ZMS:CLEAR', 'EB:CLEAR']);
  });
});

describe('RealEncumbranceRegistry', () => {
  it('fails closed for every asset type — no guessed endpoint', async () => {
    const real = new RealEncumbranceRegistry();
    for (const t of ENCUMBRANCE_ASSET_TYPES) await expect(real.check(t, 'X1'), t).rejects.toBeInstanceOf(IntegrationNotImplementedError);
  });
});

describe('asset types and mode selection', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('lists exactly the five checkable asset types', () => {
    expect([...ENCUMBRANCE_ASSET_TYPES]).toEqual(['VEHICLE', 'APARTMENT', 'HOUSE', 'LAND', 'EQUIPMENT']);
    for (const t of ['LIVESTOCK', 'INVENTORY', 'OTHER', 'vehicle', '']) expect(isEncumbranceAssetType(t), t).toBe(false);
  });

  it('mock by default and when INTEGRATION_MODE=mock; real when INTEGRATION_MODE=real; rejects junk; refuses an unset mode in production', () => {
    expect(createEncumbranceRegistry({})).toBeInstanceOf(MockEncumbranceRegistry);
    expect(createEncumbranceRegistry({ INTEGRATION_MODE: 'mock' })).toBeInstanceOf(MockEncumbranceRegistry);
    expect(createEncumbranceRegistry({ INTEGRATION_MODE: 'real' })).toBeInstanceOf(RealEncumbranceRegistry);
    expect(() => createEncumbranceRegistry({ INTEGRATION_MODE: 'staging' })).toThrow(/INTEGRATION_MODE/);
    expect(() => createEncumbranceRegistry({ NODE_ENV: 'production' })).toThrow(/INTEGRATION_MODE/);
  });

  it('EncumbranceIntegrationModule provides the registry chosen by the environment', async () => {
    vi.stubEnv('INTEGRATION_MODE', '');
    expect((await Test.createTestingModule({ imports: [EncumbranceIntegrationModule] }).compile()).get(ENCUMBRANCE_REGISTRY)).toBeInstanceOf(MockEncumbranceRegistry);
    vi.stubEnv('INTEGRATION_MODE', 'real');
    expect((await Test.createTestingModule({ imports: [EncumbranceIntegrationModule] }).compile()).get(ENCUMBRANCE_REGISTRY)).toBeInstanceOf(RealEncumbranceRegistry);
  });

  it('EncumbranceUnavailableError is an Error with a stable name and a message that carries no identifier', () => {
    const e = new EncumbranceUnavailableError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('EncumbranceUnavailableError');
    expect(e.message).toContain('ЗМС');
  });
});
