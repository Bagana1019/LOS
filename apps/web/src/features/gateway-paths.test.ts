import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API } from '../lib/api';
import * as borrowers from './borrowers/borrowers.api';
import * as notifications from './notifications/notifications.api';
import * as payments from './payments/payments.api';
import * as reports from './reports/reports.api';

// Gateway зөвхөн `/api/<service>/*`-ийг дамжуулдаг (apps/gateway proxy.controller). origination-ий endpoint-ууд `/api/origination/…`;
// угтвар дутвал бодит gateway 404 өгнө, mock-той e2e үүнийг нуудаг тул энд тогтооно.
let urls: string[];
beforeEach(() => {
  urls = [];
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(url);
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('origination-ий feature API-ууд gateway-ийн `/origination` угтвартай', () => {
  const cases: Array<[string, () => Promise<unknown>, string]> = [
    ['borrowers: list', () => borrowers.fetchBorrowers('a1'), '/applications/a1/borrowers'],
    ['payments: providers', () => payments.fetchProviders(), '/payments/providers'],
    ['payments: history', () => payments.fetchPayments('a1'), '/applications/a1/payments'],
    ['reports: definitions', () => reports.fetchReportDefinitions(), '/reports'],
    ['reports: dashboard', () => reports.fetchDashboard({}), '/reports/dashboard/summary'],
    ['notifications: bell count', () => notifications.fetchUnreadCount(), '/notifications/unread-count'],
    ['notifications: templates', () => notifications.fetchTemplates(), '/notifications/templates'],
  ];
  it.each(cases)('%s', async (_name, call, path) => {
    await call();
    expect(urls).toEqual([`${API}/origination${path}`]);
  });
});
