import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API } from '../../lib/api';
import * as api from './customers.api';

// Иргэний зөвшөөрөл: origination-ийн `/customers/xyp-otp` (код хүсэх) ба `/customers/xyp-fetch` (кодоор татах). Gateway зөвхөн `/api/<service>/*`-ийг дамжуулна.
let calls: Array<{ url: string; method: string; body: unknown }>;
beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('customers API · ХУР иргэний код', () => {
  it('xypRequestOtp: POST /origination/customers/xyp-otp — зөвхөн регистр (утасны дугаар илгээхгүй)', async () => {
    await api.xypRequestOtp('УБ90010112');
    expect(calls).toEqual([{ url: `${API}/origination/customers/xyp-otp`, method: 'POST', body: { registerNo: 'УБ90010112' } }]);
  });

  it('xypFetch: POST /origination/customers/xyp-fetch — регистр + иргэний код', async () => {
    await api.xypFetch('УБ90010112', '123456');
    expect(calls).toEqual([{ url: `${API}/origination/customers/xyp-fetch`, method: 'POST', body: { registerNo: 'УБ90010112', otp: '123456' } }]);
  });

  it('kyc-ийн замыг шууд дуудахгүй (gateway-д ажилтанд хаалттай — хязгаар, аудит origination-д)', async () => {
    await api.xypRequestOtp('УБ90010112');
    await api.xypFetch('УБ90010112', '123456');
    for (const c of calls) expect(c.url).not.toContain('/kyc/');
  });
});
