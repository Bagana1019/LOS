import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { EncumbranceSourceResult } from '@los/contracts';
import { DomainError, FixedClock } from '@los/nest-common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationNotImplementedError } from '../../integrations/errors';
import { EncumbranceUnavailableError, type EncumbranceAssetType, type EncumbranceRegistry } from '../../integrations/encumbrance/encumbrance.registry';
import { MockEncumbranceRegistry } from '../../integrations/encumbrance/mock-encumbrance.registry';
import { CollateralChecksService } from './collateral-checks.service';

const NOW = new Date('2026-10-29T08:30:00.000Z');
const src = (source: 'ZMS' | 'EB', status: EncumbranceSourceResult['status'], over: Partial<EncumbranceSourceResult> = {}): EncumbranceSourceResult => ({
  source, status, pledgee: null, registeredAt: null, note: null, ...over,
});

const make = (registry: EncumbranceRegistry) => new CollateralChecksService(registry, new FixedClock(NOW));
const fake = (impl: (type: EncumbranceAssetType, identifier: string) => Promise<unknown>) => {
  const check = vi.fn(impl);
  return { registry: { check } as unknown as EncumbranceRegistry, check };
};
const failure = async (p: Promise<unknown>): Promise<DomainError> => {
  try { await p; } catch (e) { return e as DomainError; }
  throw new Error('expected the call to fail');
};

describe('CollateralChecksService.checkEncumbrance (FR-6.6)', () => {
  let logged: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined); });
  afterEach(() => vi.restoreAllMocks());

  it('CLEAR with both sources, checkedAt from the injected Clock', async () => {
    const res = await make(new MockEncumbranceRegistry()).checkEncumbrance({ assetType: 'VEHICLE', identifier: 'УЕН5246' });
    expect(res).toEqual({
      status: 'CLEAR',
      sources: [src('ZMS', 'CLEAR'), src('EB', 'CLEAR')],
      checkedAt: '2026-10-29T08:30:00.000Z',
    });
  });

  it('ENCUMBERED (ЗМС pledgee) and DISPUTED (ЭБ) from the mock rule', async () => {
    const svc = make(new MockEncumbranceRegistry());
    const enc = await svc.checkEncumbrance({ assetType: 'VEHICLE', identifier: 'УЕН5247' });
    expect(enc.status).toBe('ENCUMBERED');
    expect(enc.sources[0]).toMatchObject({ source: 'ZMS', status: 'ENCUMBERED', pledgee: 'Жишээ ББСБ' });
    const dis = await svc.checkEncumbrance({ assetType: 'APARTMENT', identifier: 'MOCK-УБ90010112-9' });
    expect(dis.status).toBe('DISPUTED');
    expect(dis.sources[1]).toMatchObject({ source: 'EB', status: 'DISPUTED' });
  });

  it('checks every applicable asset type, passing the normalized identifier to the registry', async () => {
    const { registry, check } = fake(async () => [src('ZMS', 'CLEAR'), src('EB', 'CLEAR')]);
    const svc = make(registry);
    await svc.checkEncumbrance({ assetType: 'VEHICLE', identifier: ' 1234-уба ' });
    await svc.checkEncumbrance({ assetType: 'APARTMENT', identifier: ' mock-уб90010112-1 ' });
    await svc.checkEncumbrance({ assetType: 'HOUSE', identifier: 'h-1' });
    await svc.checkEncumbrance({ assetType: 'LAND', identifier: 'l-1' });
    await svc.checkEncumbrance({ assetType: 'EQUIPMENT', identifier: 'sn-1' });
    expect(check.mock.calls).toEqual([
      ['VEHICLE', '1234УБА'], ['APARTMENT', 'MOCK-УБ90010112-1'], ['HOUSE', 'H-1'], ['LAND', 'L-1'], ['EQUIPMENT', 'SN-1'],
    ]);
  });

  it('combines the worst status: DISPUTED over ENCUMBERED over CLEAR, with sources ordered ЗМС then ЭБ', async () => {
    const { registry } = fake(async () => [src('EB', 'DISPUTED'), src('ZMS', 'ENCUMBERED', { pledgee: 'X' })]);
    const res = await make(registry).checkEncumbrance({ assetType: 'LAND', identifier: 'L1' });
    expect(res.status).toBe('DISPUTED');
    expect(res.sources.map((s) => s.source)).toEqual(['ZMS', 'EB']);
  });

  it.each(['LIVESTOCK', 'INVENTORY', 'OTHER'] as const)('422 ENCUMBRANCE_CHECK_NOT_APPLICABLE for %s, without calling the registry', async (assetType) => {
    const { registry, check } = fake(async () => []);
    const e = await failure(make(registry).checkEncumbrance({ assetType, identifier: 'X1' }));
    expect(e).toBeInstanceOf(DomainError);
    expect(e.code).toBe('ENCUMBRANCE_CHECK_NOT_APPLICABLE');
    expect(e.getStatus()).toBe(422);
    expect(e.message).toMatch(/[А-Яа-я]/); // монгол мессеж
    expect(check).not.toHaveBeenCalled();
  });

  it('400 INVALID_IDENTIFIER when nothing is left after normalization (e.g. a plate of dashes)', async () => {
    const { registry, check } = fake(async () => []);
    const e = await failure(make(registry).checkEncumbrance({ assetType: 'VEHICLE', identifier: '---' }));
    expect([e.code, e.getStatus()]).toEqual(['INVALID_IDENTIFIER', 400]);
    expect(check).not.toHaveBeenCalled();
  });

  it('503 ENCUMBRANCE_UNAVAILABLE when a source is down (mock ERR suffix) — never a CLEAR result', async () => {
    const e = await failure(make(new MockEncumbranceRegistry()).checkEncumbrance({ assetType: 'VEHICLE', identifier: 'УЕН5246ERR' }));
    expect([e.code, e.getStatus()]).toEqual(['ENCUMBRANCE_UNAVAILABLE', 503]);
    expect(e.message).toContain('түр ажиллахгүй');
  });

  it('503 when the registry answers with only one source, even if that source says CLEAR or ENCUMBERED (fail closed)', async () => {
    for (const partial of [[src('ZMS', 'CLEAR')], [src('EB', 'CLEAR')], [src('ZMS', 'ENCUMBERED')], []]) {
      const e = await failure(make(fake(async () => partial).registry).checkEncumbrance({ assetType: 'VEHICLE', identifier: 'УЕН5246' }));
      expect(e.code).toBe('ENCUMBRANCE_UNAVAILABLE');
    }
  });

  it('503 when nothing was actually checked (all NOT_APPLICABLE) or the answer is malformed', async () => {
    for (const bad of [[src('ZMS', 'NOT_APPLICABLE'), src('EB', 'NOT_APPLICABLE')], 'oops', null, [{ source: 'ZMS', status: 'MAYBE' }], [{ ...src('ZMS', 'CLEAR'), status: undefined }, src('EB', 'CLEAR')]]) {
      const e = await failure(make(fake(async () => bad).registry).checkEncumbrance({ assetType: 'VEHICLE', identifier: 'УЕН5246' }));
      expect([e.code, e.getStatus()], JSON.stringify(bad)).toEqual(['ENCUMBRANCE_UNAVAILABLE', 503]);
    }
  });

  it('501 INTEGRATION_NOT_IMPLEMENTED for the real adapter stub', async () => {
    const e = await failure(make(fake(async () => { throw new IntegrationNotImplementedError('encumbrance'); }).registry).checkEncumbrance({ assetType: 'VEHICLE', identifier: 'УЕН5246' }));
    expect([e.code, e.getStatus()]).toEqual(['INTEGRATION_NOT_IMPLEMENTED', 501]);
  });

  it('an unexpected registry error also fails closed (503) and only its class name reaches the log — no identifier, no message', async () => {
    const secret = 'УЕН5246 (регистр УБ90010112)';
    const boom = fake(async () => { throw new TypeError(`socket hang up while checking ${secret}`); });
    const e = await failure(make(boom.registry).checkEncumbrance({ assetType: 'VEHICLE', identifier: 'УЕН5246' }));
    expect([e.code, e.getStatus()]).toEqual(['ENCUMBRANCE_UNAVAILABLE', 503]);
    expect(logged).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(logged.mock.calls);
    expect(line).toContain('TypeError');
    expect(line).not.toContain('УЕН5246');
    expect(line).not.toContain('УБ90010112');
    expect(line).not.toContain('socket hang up');
  });

  it('a registry that throws a non-Error value is handled the same way', async () => {
    const e = await failure(make(fake(async () => { throw 'plain string'; }).registry).checkEncumbrance({ assetType: 'VEHICLE', identifier: 'УЕН5246' }));
    expect(e.code).toBe('ENCUMBRANCE_UNAVAILABLE');
    expect(JSON.stringify(logged.mock.calls)).not.toContain('plain string');
  });

  it('does not log anything on success or on handled errors that carry no data (unavailable)', async () => {
    const svc = make(new MockEncumbranceRegistry());
    await svc.checkEncumbrance({ assetType: 'VEHICLE', identifier: 'УЕН5246' });
    await failure(make(fake(async () => { throw new EncumbranceUnavailableError(); }).registry).checkEncumbrance({ assetType: 'VEHICLE', identifier: 'УЕН5246' }));
    expect(logged).not.toHaveBeenCalled();
  });

  it('strips unknown fields a registry adapter might add (e.g. owner names)', async () => {
    const leaky = fake(async () => [{ ...src('ZMS', 'CLEAR'), ownerName: 'Жишээ Хүн' }, { ...src('EB', 'CLEAR'), ownerRegisterNo: 'УБ90010112' }]);
    const res = await make(leaky.registry).checkEncumbrance({ assetType: 'VEHICLE', identifier: 'УЕН5246' });
    expect(JSON.stringify(res)).not.toContain('Жишээ Хүн');
    expect(JSON.stringify(res)).not.toContain('УБ90010112');
  });
});
