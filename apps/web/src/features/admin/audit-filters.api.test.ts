import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API } from '../../lib/api';
import { fetchAuditActors, fetchAuthAudit, fetchOriginationAudit } from './admin.api';

// F9-24 · "Хэн" хайлт нь gateway-ийн өөрийн (iam) `/admin/*` хаяг (origination-ий угтваргүй). Mock-той e2e `/origination` угтварыг хасдаг тул хаягийг энд тогтооно.
let urls: string[];
const stubFetch = (body: unknown) =>
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(url);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
beforeEach(() => { urls = []; });
afterEach(() => vi.unstubAllGlobals());

describe('fetchAuditActors', () => {
  it('GET /admin/audit-actors?q=… (gateway iam, origination-ий угтваргүй); кирилл q кодлогдоно', async () => {
    stubFetch([]);
    await fetchAuditActors('адм');
    expect(urls).toEqual([`${API}/admin/audit-actors?q=${encodeURIComponent('адм')}`]);
  });
  it('хоосон q → параметргүй (бүх жагсаалтын эхний хэсэг)', async () => {
    stubFetch([]);
    await fetchAuditActors('');
    expect(urls).toEqual([`${API}/admin/audit-actors`]);
  });
  it('хариуг { id, username, fullName }[] гэж шалгаж буцаана', async () => {
    const rows = [{ id: 'u1', username: 'admin', fullName: 'Админ' }];
    stubFetch(rows);
    await expect(fetchAuditActors('a')).resolves.toEqual(rows);
  });
  it('буруу хэлбэртэй хариуг (дутуу талбар) шууд зөвшөөрөхгүй', async () => {
    stubFetch([{ id: 'u1', username: 'admin' }]);
    await expect(fetchAuditActors('a')).rejects.toBeDefined();
  });
});

describe('аудитын сонголтын жишээ авалт (объект/үйлдэл)', () => {
  it('Зээлийн систем: /origination/audit-logs?pageSize=200; Нэвтрэлт: /admin/audit-logs?pageSize=200 — өөр шүүлтгүй', async () => {
    stubFetch({});
    await fetchOriginationAudit({ pageSize: 200 }).catch(() => undefined);
    await fetchAuthAudit({ pageSize: 200 }).catch(() => undefined);
    expect(urls).toEqual([`${API}/origination/audit-logs?pageSize=200`, `${API}/admin/audit-logs?pageSize=200`]);
  });
});
