import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import * as api from './notifications.api';

// backend NotificationController-тэй яг таарсан замууд (apps/origination/src/modules/notification/notification.controller.ts).
interface Call { url: string; method: string; body: unknown }
let calls: Call[];
let respond: (call: Call) => { status: number; body?: unknown };

beforeEach(() => {
  calls = [];
  respond = () => ({ status: 200, body: {} });
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const call: Call = { url: url.replace(/^https?:\/\/[^/]+\/api\/origination/, ''), method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body };
    calls.push(call);
    const r = respond(call);
    return Promise.resolve({ ok: r.status < 400, status: r.status, statusText: 'x', json: () => Promise.resolve(r.body ?? null) });
  });
});
afterEach(() => vi.unstubAllGlobals());

const last = () => calls[calls.length - 1];

describe('ажилтны хонх', () => {
  it('GET /notifications — query-г зөв угсарна', async () => {
    await api.fetchNotifications({ unreadOnly: true, page: 2, pageSize: 8 });
    expect(last()).toEqual({ url: '/notifications?unreadOnly=true&page=2&pageSize=8', method: 'GET', body: undefined });
    await api.fetchNotifications({ unreadOnly: false, page: 1, pageSize: 20 });
    expect(last().url).toBe('/notifications?page=1&pageSize=20');
  });

  it('GET /notifications/unread-count', async () => {
    respond = () => ({ status: 200, body: { unreadCount: 3 } });
    await expect(api.fetchUnreadCount()).resolves.toEqual({ unreadCount: 3 });
    expect(last().url).toBe('/notifications/unread-count');
  });

  it('POST /notifications/:id/read — id-г кодлоно', async () => {
    await api.markRead('a/b c');
    expect(last()).toMatchObject({ url: '/notifications/a%2Fb%20c/read', method: 'POST' });
  });

  it('POST /notifications/read-all', async () => {
    respond = () => ({ status: 200, body: { updated: 4 } });
    await expect(api.markAllRead()).resolves.toEqual({ updated: 4 });
    expect(last()).toMatchObject({ url: '/notifications/read-all', method: 'POST' });
  });

  it('404 NOTIFICATION_NOT_FOUND нь ApiError болно', async () => {
    respond = () => ({ status: 404, body: { code: 'NOTIFICATION_NOT_FOUND', message: 'Мэдэгдэл олдсонгүй' } });
    await expect(api.markRead('x')).rejects.toMatchObject({ status: 404, code: 'NOTIFICATION_NOT_FOUND' });
    await expect(api.markRead('x')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('загвар', () => {
  it('GET /notifications/templates', async () => {
    await api.fetchTemplates();
    expect(last()).toMatchObject({ url: '/notifications/templates', method: 'GET' });
  });

  it('PUT /notifications/templates', async () => {
    const body = { type: 'PAYMENT_DUE', channel: 'SMS', locale: 'mn', subject: null, body: 'Сайн уу', isActive: true } as const;
    await api.upsertTemplate(body);
    expect(last()).toEqual({ url: '/notifications/templates', method: 'PUT', body });
  });

  it('POST /notifications/templates/preview', async () => {
    const body = { type: 'APPROVED', channel: 'EMAIL', subject: 'Гарчиг', body: 'Агуулга' } as const;
    await api.previewTemplate(body);
    expect(last()).toEqual({ url: '/notifications/templates/preview', method: 'POST', body });
  });
});

describe('хүргэлт, туршилт, сануулга', () => {
  it('GET /notifications/deliveries — шүүлт, хуудаслалт', async () => {
    await api.fetchDeliveries({ status: 'FAILED', channel: 'EMAIL', applicationId: ' app-1 ', page: 3, pageSize: 50 });
    expect(last()).toMatchObject({ method: 'GET', url: '/notifications/deliveries?status=FAILED&channel=EMAIL&applicationId=app-1&page=3&pageSize=50' });
    await api.fetchDeliveries({ page: 1, pageSize: 20 });
    expect(last().url).toBe('/notifications/deliveries?page=1&pageSize=20');
  });

  it('POST /notifications/test-send', async () => {
    const body = { channel: 'SMS', to: '+97699112233', type: 'PAYMENT_DUE' } as const;
    await api.sendTest(body);
    expect(last()).toEqual({ url: '/notifications/test-send', method: 'POST', body });
  });

  it('POST /notifications/reminders/run', async () => {
    await api.runReminders({ dryRun: true });
    expect(last()).toEqual({ url: '/notifications/reminders/run', method: 'POST', body: { dryRun: true } });
    await api.runReminders({ asOf: '2026-11-28', dryRun: false });
    expect(last().body).toEqual({ asOf: '2026-11-28', dryRun: false });
  });
});

describe('сувгийн opt-out', () => {
  it('GET/PUT /notifications/preferences/:recipientType/:recipientId', async () => {
    await api.fetchPreferences('CUSTOMER', 'c/1');
    expect(last()).toMatchObject({ url: '/notifications/preferences/CUSTOMER/c%2F1', method: 'GET' });
    const body = { channels: [{ channel: 'SMS' as const, enabled: false }] };
    await api.putPreferences('CUSTOMER', 'c1', body);
    expect(last()).toEqual({ url: '/notifications/preferences/CUSTOMER/c1', method: 'PUT', body });
  });
});

// UI-ийн дуудлага бүр backend controller-ийн бодит маршрутад таарч байгааг шалгана (controller өөрчлөгдвөл энд мэдэгдэнэ).
const controllerFile = fileURLToPath(new URL('../../../../origination/src/modules/notification/notification.controller.ts', import.meta.url));

describe.skipIf(!existsSync(controllerFile))('backend controller-ийн маршруттай нийцэл', () => {
  it('UI-ийн дуудлага бүр controller-ийн маршрутад таарна', async () => {
    const source = readFileSync(controllerFile, 'utf8');
    const routes = [...source.matchAll(/@(Get|Post|Put|Delete)\('([^']+)'\)/g)].map((m) => ({
      method: m[1].toUpperCase(),
      pattern: new RegExp(`^/${m[2].replace(/:[A-Za-z]+/g, '[^/]+')}$`),
    }));
    expect(routes.length).toBeGreaterThanOrEqual(13);

    await api.fetchNotifications({ unreadOnly: true, page: 1, pageSize: 8 });
    await api.fetchUnreadCount();
    await api.markRead('n1');
    await api.markAllRead();
    await api.fetchTemplates();
    await api.upsertTemplate({ type: 'APPROVED', channel: 'SMS', locale: 'mn', subject: null, body: 'x', isActive: true });
    await api.previewTemplate({ type: 'APPROVED', channel: 'SMS', body: 'x' });
    await api.fetchDeliveries({ page: 1, pageSize: 20 });
    await api.sendTest({ channel: 'SMS', to: '+97699112233', type: 'PAYMENT_DUE' });
    await api.runReminders({ dryRun: true });
    await api.fetchPreferences('CUSTOMER', 'c1');
    await api.putPreferences('CUSTOMER', 'c1', { channels: [{ channel: 'SMS', enabled: true }] });

    expect(calls).toHaveLength(12);
    for (const c of calls) {
      const path = c.url.split('?')[0];
      expect(routes.some((r) => r.method === c.method && r.pattern.test(path)), `${c.method} ${path}`).toBe(true);
    }
  });
});
