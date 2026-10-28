import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';

describe.skipIf(!process.env.TEST_DATABASE_URL)('dms service foundation', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it('GET /api/health is 200 and public; /api/health/ready checks the database', async () => {
    const res = await request(app.getHttpServer()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ service: 'dms', ok: true });
    expect((await request(app.getHttpServer()).get('/api/health/ready')).body.checks).toEqual({ db: 'up' });
  });
});
