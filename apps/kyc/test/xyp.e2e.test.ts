import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { XypCitizen } from '@los/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MOCK_XYP_OTP } from '../src/integrations/xyp/mock-xyp.client';
import { as, createApp } from './app';

describe.skipIf(!process.env.TEST_DATABASE_URL)('kyc · POST /api/xyp/citizen (FR-2.2)', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createApp(); });
  afterAll(async () => { await app.close(); });
  // Иргэний код (otp) заавал: кодгүй дуудлага ХУР руу явахгүй (XypCitizenRequest). Default параметр `undefined`-ийг дарна — талбар байхгүй тохиолдлыг түүхий body-гоор шалга.
  const post = (who: Parameters<typeof as>[0], registerNo: unknown, otp: unknown = MOCK_XYP_OTP) => request(app.getHttpServer()).post('/api/xyp/citizen').set(as(who)).send({ registerNo, otp });
  const postOtp = (who: Parameters<typeof as>[0], body: unknown) => request(app.getHttpServer()).post('/api/xyp/citizen/otp').set(as(who)).send(body as object);

  it('returns the citizen for an officer; the register is normalized (case, spaces)', async () => {
    const res = await post('officerA', 'уб 90010112');
    expect(res.status).toBe(200);
    expect(XypCitizen.parse(res.body)).toMatchObject({ registerNo: 'УБ90010112', customerType: 'INDIVIDUAL', gender: 'FEMALE', birthDate: '1990-01-01' });
  });

  it('404 XYP_NOT_FOUND when XYP has no such person', async () => {
    const res = await post('officerA', 'УБ00000000');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('XYP_NOT_FOUND');
  });

  it('503 XYP_UNAVAILABLE when XYP is down — the officer is told to fill the form by hand', async () => {
    const res = await post('officerA', 'УБ99999999');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('XYP_UNAVAILABLE');
  });

  it('400 for a malformed register or body', async () => {
    expect((await post('officerA', 'AB123')).body.code).toBe('INVALID_REGISTER_NO');
    expect((await post('officerA', '')).status).toBe(400);
    expect((await request(app.getHttpServer()).post('/api/xyp/citizen').set(as('officerA')).send({})).body.code).toBe('VALIDATION_FAILED');
  });

  it('400 VALIDATION_FAILED when the citizen code is missing or malformed — the request never reaches XYP', async () => {
    for (const otp of [null, '', '123', '123456789', 'abcdef', 123456]) {
      const res = await post('officerA', 'УБ90010112', otp);
      expect(res.status, `otp=${JSON.stringify(otp)}`).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    const noOtp = await request(app.getHttpServer()).post('/api/xyp/citizen').set(as('officerA')).send({ registerNo: 'УБ90010112' });
    expect([noOtp.status, noOtp.body.code]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('422 XYP_OTP_INVALID for a well-formed but wrong citizen code; the code is not echoed back', async () => {
    const res = await post('officerA', 'УБ90010112', '000000');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('XYP_OTP_INVALID');
    expect(JSON.stringify(res.body)).not.toContain('000000');
  });

  it('only roles that may write customers can pull personal data (approver and branch manager cannot); anonymous is 401', async () => {
    expect((await post('approver', 'УБ90010112')).status).toBe(403);
    expect((await post('manager', 'УБ90010112')).status).toBe(403);
    expect((await request(app.getHttpServer()).post('/api/xyp/citizen').send({ registerNo: 'УБ90010112', otp: MOCK_XYP_OTP })).status).toBe(401);
  });

  describe('POST /api/xyp/citizen/otp — step 1: XYP sends the code to the citizen\'s registered phone', () => {
    it('200 sent for an officer; the register is normalized and no phone number is part of the response', async () => {
      const res = await postOtp('officerA', { registerNo: 'уб 90010112' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ sent: true });
      expect(typeof res.body.requestedAt).toBe('string');
      expect(Object.keys(res.body).sort()).toEqual(['requestedAt', 'sent']);
    });

    it('404 XYP_NOT_FOUND when XYP has no such register; 503 XYP_UNAVAILABLE when XYP is down', async () => {
      const missing = await postOtp('officerA', { registerNo: 'УБ00000000' });
      expect([missing.status, missing.body.code]).toEqual([404, 'XYP_NOT_FOUND']);
      const down = await postOtp('officerA', { registerNo: 'УБ99999999' });
      expect([down.status, down.body.code]).toEqual([503, 'XYP_UNAVAILABLE']);
    });

    it('400 for a malformed register; a caller-chosen phone is rejected (strict body) — the code only goes to the registered phone', async () => {
      expect((await postOtp('officerA', { registerNo: 'AB123' })).body.code).toBe('INVALID_REGISTER_NO');
      const withPhone = await postOtp('officerA', { registerNo: 'УБ90010112', phoneNum: 99112233 });
      expect(withPhone.status).toBe(400);
      expect(withPhone.body.code).toBe('VALIDATION_FAILED');
    });

    it('403 for approver and branch manager; 401 anonymous', async () => {
      expect((await postOtp('approver', { registerNo: 'УБ90010112' })).status).toBe(403);
      expect((await postOtp('manager', { registerNo: 'УБ90010112' })).status).toBe(403);
      expect((await request(app.getHttpServer()).post('/api/xyp/citizen/otp').send({ registerNo: 'УБ90010112' })).status).toBe(401);
    });
  });
});
