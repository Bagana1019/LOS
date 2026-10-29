import { XypCitizen } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { IntegrationNotImplementedError } from '../errors';
import { MockXypClient } from './mock-xyp.client';
import { RealXypClient } from './real-xyp.client';
import { XypUnavailableError } from './xyp.client';
import { createXypClient } from './xyp.module';

describe('MockXypClient (deterministic fixture)', () => {
  const xyp = new MockXypClient();

  it('returns the same valid citizen for the same register every time', async () => {
    const a = await xyp.getCitizen('УБ90010112');
    const b = await xyp.getCitizen('УБ90010112');
    expect(a).toEqual(b);
    expect(XypCitizen.parse(a)).toBeTruthy();
  });

  it('derives birth date and gender from the register digits (even last digit = female, month+20 = born 2000+)', async () => {
    expect(await xyp.getCitizen('УБ90010111')).toMatchObject({ customerType: 'INDIVIDUAL', birthDate: '1990-01-01', gender: 'MALE' });
    expect(await xyp.getCitizen('УБ90010112')).toMatchObject({ birthDate: '1990-01-01', gender: 'FEMALE' });
    expect(await xyp.getCitizen('ЧЛ05210504')).toMatchObject({ birthDate: '2005-01-05', gender: 'FEMALE' });
  });

  it('falls back to a stable valid date when the digits are not a date', async () => {
    const c = (await xyp.getCitizen('УБ12345678'))!;
    expect(c.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${c.birthDate}T00:00:00Z`).toISOString().slice(0, 10)).toBe(c.birthDate);
    expect(c).toEqual((await xyp.getCitizen('УБ12345678'))!);
  });

  it('fills 10+ fields for an individual and the legal-entity subset for a company', async () => {
    const c = (await xyp.getCitizen('УБ90010112'))!;
    const filled = Object.values({ ...c, ...c.address }).filter((v) => v !== null && typeof v !== 'object');
    expect(filled.length).toBeGreaterThanOrEqual(10);
    expect(await xyp.getCitizen('5012345')).toMatchObject({ customerType: 'LEGAL_ENTITY', lastName: null, gender: null, birthDate: null });
  });

  it('answers not-found for zero registers and for malformed ones, and simulates an outage for nines', async () => {
    expect(await xyp.getCitizen('УБ00000000')).toBeNull();
    expect(await xyp.getCitizen('0000000')).toBeNull();
    expect(await xyp.getCitizen('garbage')).toBeNull();
    await expect(xyp.getCitizen('УБ99999999')).rejects.toBeInstanceOf(XypUnavailableError);
  });

  it('does not let a caller corrupt the fixture', async () => {
    const c = (await xyp.getCitizen('УБ90010112'))!;
    c.firstName = 'Hacked';
    c.address!.detail = 'Hacked';
    const again = (await xyp.getCitizen('УБ90010112'))!;
    expect(again.firstName).not.toBe('Hacked');
    expect(again.address!.detail).not.toBe('Hacked');
  });
});

describe('mode selection', () => {
  it('mock by default, real when INTEGRATION_MODE=real (fails closed until implemented)', async () => {
    expect(createXypClient({})).toBeInstanceOf(MockXypClient);
    const real = createXypClient({ INTEGRATION_MODE: 'real' });
    expect(real).toBeInstanceOf(RealXypClient);
    await expect(real.getCitizen('УБ90010112')).rejects.toBeInstanceOf(IntegrationNotImplementedError);
  });
});
