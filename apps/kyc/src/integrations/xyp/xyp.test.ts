import { XypCitizen } from '@los/contracts';
import { describe, expect, it } from 'vitest';
import { IntegrationNotConfiguredError, IntegrationNotImplementedError } from '../errors';
import { MOCK_XYP_OTP, MockXypClient } from './mock-xyp.client';
import { RealXypClient } from './real-xyp.client';
import { XypOtpRejectedError, XypUnavailableError } from './xyp.client';
import { createXypClient } from './xyp.module';

const OTP = MOCK_XYP_OTP;

describe('MockXypClient (deterministic fixture)', () => {
  const xyp = new MockXypClient();

  it('demo код: зөвхөн MOCK_XYP_OTP (123456) хүлээн авна; өөр код → XypOtpRejectedError, fixture-г задруулахгүй', async () => {
    expect(OTP).toBe('123456');
    expect(await xyp.getCitizen('УБ90010112', OTP)).toMatchObject({ firstName: expect.any(String) });
    await expect(xyp.getCitizen('УБ90010112', '000000')).rejects.toBeInstanceOf(XypOtpRejectedError);
  });

  it('requestCitizenOtp: олдсон регистрт true; олдохгүй (тэг / буруу хэлбэр) false; nines → XypUnavailableError', async () => {
    expect(await xyp.requestCitizenOtp('УБ90010112')).toBe(true);
    expect(await xyp.requestCitizenOtp('УБ00000000')).toBe(false);
    expect(await xyp.requestCitizenOtp('garbage')).toBe(false);
    await expect(xyp.requestCitizenOtp('УБ99999999')).rejects.toBeInstanceOf(XypUnavailableError);
  });

  it('олдохгүй регистр код буруу байсан ч null (регистрийн оршихуйг эхлээд шалгана)', async () => {
    expect(await xyp.getCitizen('УБ00000000', '000000')).toBeNull();
  });

  it('returns the same valid citizen for the same register every time', async () => {
    const a = await xyp.getCitizen('УБ90010112', OTP);
    const b = await xyp.getCitizen('УБ90010112', OTP);
    expect(a).toEqual(b);
    expect(XypCitizen.parse(a)).toBeTruthy();
  });

  it('derives birth date and gender from the register digits (even last digit = female, month+20 = born 2000+)', async () => {
    expect(await xyp.getCitizen('УБ90010111', OTP)).toMatchObject({ customerType: 'INDIVIDUAL', birthDate: '1990-01-01', gender: 'MALE' });
    expect(await xyp.getCitizen('УБ90010112', OTP)).toMatchObject({ birthDate: '1990-01-01', gender: 'FEMALE' });
    expect(await xyp.getCitizen('ЧЛ05210504', OTP)).toMatchObject({ birthDate: '2005-01-05', gender: 'FEMALE' });
  });

  it('falls back to a stable valid date when the digits are not a date', async () => {
    const c = (await xyp.getCitizen('УБ12345678', OTP))!;
    expect(c.birthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${c.birthDate}T00:00:00Z`).toISOString().slice(0, 10)).toBe(c.birthDate);
    expect(c).toEqual((await xyp.getCitizen('УБ12345678', OTP))!);
  });

  it('never crashes on a well-formed register whose date part is impossible (day 56, month 31): falls back to a stable valid date', async () => {
    for (const reg of ['УБ90015699', 'УБ90013199', 'УБ00004599', 'УБ99999998']) {
      const c = (await xyp.getCitizen(reg, OTP))!;
      expect(new Date(`${c.birthDate}T00:00:00Z`).toISOString().slice(0, 10), reg).toBe(c.birthDate);
      expect(c).toEqual((await xyp.getCitizen(reg, OTP))!);
    }
  });

  it('fills 10+ fields for an individual and the legal-entity subset for a company', async () => {
    const c = (await xyp.getCitizen('УБ90010112', OTP))!;
    const filled = Object.values({ ...c, ...c.address }).filter((v) => v !== null && typeof v !== 'object');
    expect(filled.length).toBeGreaterThanOrEqual(10);
    expect(await xyp.getCitizen('5012345', OTP)).toMatchObject({ customerType: 'LEGAL_ENTITY', lastName: null, gender: null, birthDate: null });
  });

  it('answers not-found for zero registers and for malformed ones, and simulates an outage for nines', async () => {
    expect(await xyp.getCitizen('УБ00000000', OTP)).toBeNull();
    expect(await xyp.getCitizen('0000000', OTP)).toBeNull();
    expect(await xyp.getCitizen('garbage', OTP)).toBeNull();
    await expect(xyp.getCitizen('УБ99999999', OTP)).rejects.toBeInstanceOf(XypUnavailableError);
  });

  it('does not let a caller corrupt the fixture', async () => {
    const c = (await xyp.getCitizen('УБ90010112', OTP))!;
    c.firstName = 'Hacked';
    c.address!.detail = 'Hacked';
    const again = (await xyp.getCitizen('УБ90010112', OTP))!;
    expect(again.firstName).not.toBe('Hacked');
    expect(again.address!.detail).not.toBe('Hacked');
  });
});

describe('mode selection', () => {
  it('mock by default, real when INTEGRATION_MODE=real (fails closed without config; assets stay not implemented)', async () => {
    expect(createXypClient({})).toBeInstanceOf(MockXypClient);
    const real = createXypClient({ INTEGRATION_MODE: 'real' });
    expect(real).toBeInstanceOf(RealXypClient);
    await expect(real.getCitizen('УБ90010112', OTP)).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    await expect(real.requestCitizenOtp('УБ90010112')).rejects.toBeInstanceOf(IntegrationNotConfiguredError);
    await expect(real.getAssets('УБ90010112')).rejects.toBeInstanceOf(IntegrationNotImplementedError);
  });

  it('production + real: refuses to start without XYP config (names only, never values)', () => {
    const env = { NODE_ENV: 'production', INTEGRATION_MODE: 'real', XYP_ACCESS_TOKEN: 'token-secret-value' };
    expect(() => createXypClient(env)).toThrow(IntegrationNotConfiguredError);
    expect(() => createXypClient(env)).toThrow(/XYP_PRIVATE_KEY_PATH/);
    expect(() => createXypClient(env)).not.toThrow(/token-secret-value/);
  });
});
