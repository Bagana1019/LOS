// AppModule-д OcrModule бүртгэгдсэнийг батлах (app.module.ts-ийн өөрчлөлт: зөвхөн import + бүртгэл).
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';

// Gateway-ийн дамжуулсан identity (CommonModule-ийн глобал guard нэвтрээгүй хүсэлтийг 401 болгоно)
const identity = { 'x-user-id': 'u-officer', 'x-roles': 'OFFICER', 'x-org-id': 'org-1' };

describe('AppModule + OcrModule', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('/api/ocr/doc-types ба /api/ocr/health ажиллана, /health хэвээр', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.listen(0);
    close = () => app.close();
    const server = app.getHttpServer();

    expect((await request(server).get('/api/ocr/doc-types')).status).toBe(401); // нэвтрээгүй
    expect((await request(server).get('/api/ocr/doc-types').set(identity)).status).toBe(200);
    const health = await request(server).get('/api/ocr/health').set(identity);
    expect(health.status).toBe(200);
    expect(health.body.provider).toBe('mock');
    expect((await request(server).get('/api/health')).body).toMatchObject({ service: 'dms', ok: true });
  });
});
