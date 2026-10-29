import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { XypCitizen } from '@los/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createApp } from './app';

describe.skipIf(!process.env.TEST_DATABASE_URL)('kyc · POST /api/xyp/citizen (FR-2.2)', () => {
  let app: INestApplication;
  beforeAll(async () => { app = await createApp(); });
  afterAll(async () => { await app.close(); });
  const post = (who: Parameters<typeof as>[0], registerNo: unknown) => request(app.getHttpServer()).post('/api/xyp/citizen').set(as(who)).send({ registerNo });

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

  it('only roles that may write customers can pull personal data (approver and branch manager cannot); anonymous is 401', async () => {
    expect((await post('approver', 'УБ90010112')).status).toBe(403);
    expect((await post('manager', 'УБ90010112')).status).toBe(403);
    expect((await request(app.getHttpServer()).post('/api/xyp/citizen').send({ registerNo: 'УБ90010112' })).status).toBe(401);
  });
});
