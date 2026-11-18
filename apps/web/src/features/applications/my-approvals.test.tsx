import { renderToString } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoteRequest, type DecisionView, type MyApprovalItem } from '@los/contracts';
import { API, ApiError } from '../../lib/api';
import { hasMessage, t } from '../../lib/i18n';
import { decisionKey, voteApplication, voteTargetOf } from '../decision/decision.api';
import * as api from './applications.api';
import { describeApplicationError } from './applications.utils';
import { buildVoteRequest, isStaleVoteError } from './my-approvals';
import { MyApprovalsTable } from './MyApprovalsTable';
import { applicationListKey, invalidateAfterVote, myApprovalsKey } from './useApplications';
import { VoteTargetSummary } from './VoteTargetSummary';

// FR-1.1 / FR-1.5 (M3): "Миний батлах" таб — мөр бүрт Батлах / Буцаах (буцаахад тайлбар заавал), санал өгсний дараа жагсаалт, тоолуур шинэчлэгдэнэ.

const ID_1 = 'f1e2d3c4-b5a6-4789-8abc-def012345601';
const ID_2 = 'f1e2d3c4-b5a6-4789-8abc-def012345602';
const item = (over: Partial<MyApprovalItem> = {}): MyApprovalItem => ({
  applicationId: ID_1, appNo: 'LA-2026-000001', borrowerName: 'Бат Болд', amount: 5_000_000, currency: 'MNT', levelNo: 1, levelName: 'Салбарын захирал', totalLevels: 2, version: 1,
  startedAt: '2026-11-17T09:00:00.000Z', dueAt: '2026-11-18T09:00:00.000Z', overdue: false, ...over,
});

describe('gateway зам', () => {
  let calls: Array<{ url: string; method: string; body: unknown }>;
  const reply = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  const stub = (status: number, json: unknown) => {
    calls = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      return Promise.resolve(reply(status, json));
    });
  };
  afterEach(() => vi.unstubAllGlobals());

  it('fetchMyApprovals: origination-ийн GET /approvals/mine (өөр endpoint зохиохгүй)', async () => {
    stub(200, { items: [item()], total: 1 });
    const out = await api.fetchMyApprovals();
    expect(calls[0]).toMatchObject({ url: `${API}/origination/approvals/mine`, method: 'GET' });
    expect(out.total).toBe(1);
    expect(out.items[0]?.appNo).toBe('LA-2026-000001');
  });

  it('fetchMyApprovals: гэрээнд нийцэхгүй хариуг татгалзана', async () => {
    stub(200, { items: 'oops', total: 'x' });
    await expect(api.fetchMyApprovals()).rejects.toBeTruthy();
  });

  it('fetchDirectory: gateway-ийн өөрийн GET /directory (origination биш — §3.2 origination → gateway sync байхгүй)', async () => {
    stub(200, { branches: { b1: 'Төв салбар' }, users: { u1: 'ЗЭЗ А' } });
    const out = await api.fetchDirectory();
    expect(calls[0]).toMatchObject({ url: `${API}/directory`, method: 'GET' });
    expect(out.users.u1).toBe('ЗЭЗ А');
  });

  it('fetchDirectory: PII-тэй нэмэлт талбартай хариуг татгалзана', async () => {
    stub(200, { branches: {}, users: {}, emails: { u: 'a@b.mn' } });
    await expect(api.fetchDirectory()).rejects.toBeTruthy();
  });

  it('voteApplication: байгаа санал өгөх API — POST /applications/:id/approval/vote, id-г кодлоно', async () => {
    stub(200, {});
    await voteApplication('app/1', { decision: 'APPROVE' });
    expect(calls[0]).toMatchObject({ url: `${API}/origination/applications/app%2F1/approval/vote`, method: 'POST', body: { decision: 'APPROVE' } });
  });

  it('voteApplication: Буцаахад тайлбарыг биед дамжуулна', async () => {
    stub(200, {});
    await voteApplication(ID_1, { decision: 'RETURN', comment: 'Орлогын баримт дутуу' });
    expect(calls[0]?.body).toEqual({ decision: 'RETURN', comment: 'Орлогын баримт дутуу' });
  });

  it('өөрийн хүсэлтийг батлах оролдлого серверээс 403 SELF_APPROVAL_FORBIDDEN → ApiError, серверийн монгол мессеж хэрэглэгчид', async () => {
    stub(403, { code: 'SELF_APPROVAL_FORBIDDEN', message: 'Өөрийн хүсэлтийг батлах боломжгүй' });
    const err = await voteApplication(ID_1, { decision: 'APPROVE' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: 'SELF_APPROVAL_FORBIDDEN' });
    expect(describeApplicationError(err, 'application.mine.voteFailed')).toBe('Өөрийн хүсэлтийг батлах боломжгүй');
  });

  it.each([['ALREADY_VOTED', 409, 'Та энэ түвшинд санал өгсөн байна'], ['NOT_IN_APPROVAL', 409, 'Хүсэлт батлах шатанд байхгүй байна'], ['NOT_LEVEL_APPROVER', 403, 'Та түвшний батлагч биш']])(
    'серверийн %s алдааны мессеж алдагдахгүй',
    async (code, status, message) => {
      stub(status, { code, message });
      const err = await voteApplication(ID_1, { decision: 'APPROVE' }).catch((e: unknown) => e);
      expect(describeApplicationError(err, 'application.mine.voteFailed')).toBe(message);
    },
  );

  it('мессежгүй / сүлжээний алдаа → i18n нөөц текст', () => {
    expect(describeApplicationError(new Error('x'), 'application.mine.voteFailed')).toBe(t('application.mine.voteFailed'));
  });
});

describe('buildVoteRequest — Буцаахад тайлбар заавал (FR-1.5, серверийн VoteRequest-тэй ижил дүрэм)', () => {
  it('Батлах: тайлбаргүй', () => expect(buildVoteRequest('APPROVE')).toEqual({ decision: 'APPROVE' }));
  it('Буцаах + шалтгаан → тайрсан тайлбартай', () => expect(buildVoteRequest('RETURN', '  Орлого дутуу  ')).toEqual({ decision: 'RETURN', comment: 'Орлого дутуу' }));
  it.each([[undefined], [''], ['   '], ['\n\t']])('Буцаах + хоосон шалтгаан %j → null (илгээхгүй)', (c) => expect(buildVoteRequest('RETURN', c)).toBeNull());
  it('Буцаах + 1000-аас урт шалтгаан → null (серверийн хязгаар)', () => {
    expect(buildVoteRequest('RETURN', 'а'.repeat(1000))).not.toBeNull();
    expect(buildVoteRequest('RETURN', 'а'.repeat(1001))).toBeNull();
  });
  it('кирилл, emoji, SQL тэмдэгттэй шалтгааныг өөрчлөхгүй', () => {
    const reason = `Барьцаа "дутуу" ' OR 1=1 -- 📎`;
    expect(buildVoteRequest('RETURN', reason)).toEqual({ decision: 'RETURN', comment: reason });
  });
  it('үүсгэсэн бие бүр серверийн VoteRequest схемд нийцнэ', () => {
    for (const body of [buildVoteRequest('APPROVE'), buildVoteRequest('RETURN', 'Дутуу')]) expect(VoteRequest.safeParse(body).success).toBe(true);
  });
});

describe('санал өгсний дараа шинэчлэх (invalidateAfterVote)', () => {
  const seeded = () => {
    const qc = new QueryClient();
    qc.setQueryData(applicationListKey({ status: 'IN_APPROVAL' }), { counts: {}, myApprovalCount: 2 });
    qc.setQueryData(myApprovalsKey, { items: [item()], total: 1 });
    qc.setQueryData(decisionKey(ID_1), {});
    qc.setQueryData(decisionKey(ID_2), {});
    qc.setQueryData(['directory'], { branches: {}, users: {} });
    return qc;
  };
  const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;

  it('жагсаалт + тоолуур (myApprovalCount), "Миний батлах" жагсаалт, тухайн хүсэлтийн шийдвэр шинэчлэгдэнэ', async () => {
    const qc = seeded();
    await invalidateAfterVote(qc, ID_1);
    expect(stale(qc, applicationListKey({ status: 'IN_APPROVAL' }))).toBe(true);
    expect(stale(qc, myApprovalsKey)).toBe(true);
    expect(stale(qc, decisionKey(ID_1))).toBe(true);
  });

  it('өөр хүсэлтийн шийдвэр, лавлахыг дахин ачаалахгүй', async () => {
    const qc = seeded();
    await invalidateAfterVote(qc, ID_1);
    expect(stale(qc, decisionKey(ID_2))).toBe(false);
    expect(stale(qc, ['directory'])).toBe(false);
  });
});

describe('MyApprovalsTable (FR-1.5 мөр бүрийн үйлдэл)', () => {
  let consoleErrors: unknown[][];
  beforeEach(() => {
    consoleErrors = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => void consoleErrors.push(a));
    vi.spyOn(console, 'warn').mockImplementation((...a) => void consoleErrors.push(a));
  });
  afterEach(() => {
    expect(consoleErrors, 'console errors/warnings').toEqual([]);
    vi.restoreAllMocks();
  });

  const noop = () => undefined;
  const render = (items: MyApprovalItem[], busy = false) => renderToString(<MyApprovalsTable items={items} busy={busy} onOpen={noop} onApprove={noop} onReturn={noop} />);
  const openTag = (html: string, testId: string) => new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0];
  const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

  it('мөр бүрт Батлах, Буцаах товч', () => {
    const html = render([item(), item({ applicationId: ID_2, appNo: 'LA-2026-000002' })]);
    for (const id of [ID_1, ID_2]) {
      expect(openTag(html, `mine-approve-${id}`), `approve ${id}`).toBeTruthy();
      expect(openTag(html, `mine-return-${id}`), `return ${id}`).toBeTruthy();
    }
    const visible = text(html);
    expect(visible).toContain('Батлах');
    expect(visible).toContain('Буцаах');
  });

  it('хүсэлтийн дугаар, харилцагч, дүн, түвшин, хугацааг харуулна', () => {
    const visible = text(render([item()]));
    expect(visible).toContain('LA-2026-000001');
    expect(visible).toContain('Бат Болд');
    expect(visible).toContain('₮');
    expect(visible).toContain('1/2');
    expect(visible).toContain('Салбарын захирал');
    expect(visible).toContain('2026-11-18');
  });

  it('UUID-г хэрэглэгчид текстээр харуулахгүй', () => {
    expect(text(render([item()]))).not.toContain(ID_1);
  });

  it('SLA хэтэрсэн мөр "Хэтэрсэн" тэмдэгтэй, хэвийн мөр тэмдэггүй', () => {
    expect(text(render([item({ overdue: true })]))).toContain('Хэтэрсэн');
    expect(text(render([item({ overdue: false })]))).not.toContain('Хэтэрсэн');
  });

  it('харилцагч, дүн, хугацаа байхгүй бол "—" (null харагдахгүй)', () => {
    const visible = text(render([item({ borrowerName: null, amount: null, dueAt: null })]));
    expect(visible).toContain('—');
    expect(visible).not.toContain('null');
    expect(visible).not.toContain('undefined');
    expect(visible).not.toContain('NaN');
  });

  it('санал өгч байх үед (busy) бүх мөрийн Батлах/Буцаах идэвхгүй — давхар санал өгөхгүй', () => {
    const html = render([item(), item({ applicationId: ID_2 })], true);
    for (const id of [ID_1, ID_2]) {
      expect(openTag(html, `mine-approve-${id}`)).toMatch(/disabled/);
      expect(openTag(html, `mine-return-${id}`)).toMatch(/disabled/);
    }
  });

  it('санал өгөөгүй үед товчнууд идэвхтэй', () => {
    const html = render([item()]);
    expect(openTag(html, `mine-approve-${ID_1}`)).not.toMatch(/disabled/);
    expect(openTag(html, `mine-return-${ID_1}`)).not.toMatch(/disabled/);
  });

  it('хоосон жагсаалт → "Таны батлах хүсэлт алга"', () => {
    expect(text(render([]))).toContain('Таны батлах хүсэлт алга');
  });

  it('хүсэлтийн дугаар нь хүсэлт рүү холбоос', () => {
    expect(render([item()])).toContain(`href="/los/loan-application/${ID_1}"`);
  });

  it('500 мөртэй ч алдаагүй зурагдана', () => {
    const many = Array.from({ length: 500 }, (_, i) => item({ applicationId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, appNo: `LA-2026-${String(i).padStart(6, '0')}` }));
    expect(() => render(many)).not.toThrow();
  });
});

// FR-1.5 (M3 review): санал өгөгчийн харсан түвшин, хувилбар. Хоцрогдсон бол сервер 409 VOTE_TARGET_CHANGED.
describe('buildVoteRequest: хүлээгдэж буй түвшин / хувилбар', () => {
  it('Батлах + target → levelNo, version бие рүү орно', () => {
    expect(buildVoteRequest('APPROVE', undefined, { levelNo: 2, version: 3 })).toEqual({ decision: 'APPROVE', levelNo: 2, version: 3 });
  });
  it('Буцаах + шалтгаан + target → тайлбар тайрагдаж, target хадгалагдана', () => {
    expect(buildVoteRequest('RETURN', '  Дутуу  ', { levelNo: 1, version: 2 })).toEqual({ decision: 'RETURN', comment: 'Дутуу', levelNo: 1, version: 2 });
  });
  it('Буцаах + хоосон шалтгаан + target → null (target шалтгааны шаардлагыг тойруулахгүй)', () => {
    expect(buildVoteRequest('RETURN', '  ', { levelNo: 1, version: 2 })).toBeNull();
  });
  it('target өгөөгүй бол хуучин бие (DecisionStep-ийн хуучин дуудлагатай ижил)', () => {
    expect(buildVoteRequest('APPROVE')).toEqual({ decision: 'APPROVE' });
    expect(buildVoteRequest('APPROVE', undefined, {})).toEqual({ decision: 'APPROVE' });
  });
  it('нэг нь л байвал зөвхөн тэр орно', () => {
    expect(buildVoteRequest('APPROVE', undefined, { levelNo: 2 })).toEqual({ decision: 'APPROVE', levelNo: 2 });
    expect(buildVoteRequest('APPROVE', undefined, { version: 4 })).toEqual({ decision: 'APPROVE', version: 4 });
  });
  it.each([[0], [-1], [1.5], [Number.NaN]])('буруу levelNo %j → null (серверт хоцрогдсон биш буруу утга илгээхгүй)', (levelNo) => {
    expect(buildVoteRequest('APPROVE', undefined, { levelNo, version: 1 })).toBeNull();
  });
  it.each([[0], [-1], [2.5], [Number.NaN]])('буруу version %j → null', (version) => {
    expect(buildVoteRequest('APPROVE', undefined, { levelNo: 1, version })).toBeNull();
  });
  it('үүсгэсэн бие серверийн VoteRequest схемд нийцнэ', () => {
    expect(VoteRequest.safeParse(buildVoteRequest('RETURN', 'Дутуу', { levelNo: 1, version: 1 })).success).toBe(true);
  });
});

describe('voteApplication: target-ийг серверт дамжуулна', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('POST биед levelNo, version орно', async () => {
    let sent: unknown;
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => { sent = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body; return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })); });
    await voteApplication(ID_1, { decision: 'APPROVE', levelNo: 2, version: 3 });
    expect(sent).toEqual({ decision: 'APPROVE', levelNo: 2, version: 3 });
  });
});

describe('isStaleVoteError / VOTE_TARGET_CHANGED', () => {
  it.each(['VOTE_TARGET_CHANGED', 'NOT_IN_APPROVAL', 'ALREADY_VOTED'])('409 %s → хоцрогдсон: жагсаалт шинэчилж, буцаах цонхыг хаана', (code) => {
    expect(isStaleVoteError(new ApiError(409, code, 'x'))).toBe(true);
  });
  it.each([[403, 'SELF_APPROVAL_FORBIDDEN'], [403, 'NOT_LEVEL_APPROVER'], [400, 'VALIDATION_FAILED'], [500, null], [0, null]])('%i %s хоцрогдсон биш (шалтгаан бүхий цонх нээлттэй үлдэнэ)', (status, code) => {
    expect(isStaleVoteError(new ApiError(status, code, 'x'))).toBe(false);
  });
  it('ApiError биш (сүлжээ, null, string) хоцрогдсон биш', () => {
    for (const e of [new Error('x'), null, undefined, 'boom', { status: 409 }]) expect(isStaleVoteError(e)).toBe(false);
  });
  it('VOTE_TARGET_CHANGED: хэрэглэгчид монгол тайлбар (серверийн мессеж өөр байсан ч)', () => {
    const msg = describeApplicationError(new ApiError(409, 'VOTE_TARGET_CHANGED', 'server text'), 'application.mine.voteFailed');
    expect(msg).toMatch(/өөрчлөгдсөн/);
    expect(msg).not.toBe('server text');
  });
});

describe('voteTargetOf (DecisionStep: харж буй түвшин, хувилбар)', () => {
  const dv = (currentLevel: number | null, version: number) => ({ version, approval: { currentLevel, totalLevels: 3, levels: [] } } as Pick<DecisionView, 'version' | 'approval'>);
  it('идэвхтэй түвшин, version-ийг буцаана', () => expect(voteTargetOf(dv(2, 3))).toEqual({ levelNo: 2, version: 3 }));
  it('идэвхтэй түвшин байхгүй (null) бол зөвхөн version', () => expect(voteTargetOf(dv(null, 1))).toEqual({ version: 1 }));
  it('үр дүн buildVoteRequest-ээр хүчинтэй бие болно', () => {
    expect(buildVoteRequest('APPROVE', undefined, voteTargetOf(dv(2, 3)))).toEqual({ decision: 'APPROVE', levelNo: 2, version: 3 });
  });
});

describe('VoteTargetSummary (батлах / буцаах цонх: юунд санал өгч байгааг харуулна)', () => {
  const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  it('хүсэлтийн дугаар, харилцагч, түвшний нэр (n/N), дүнг харуулна', () => {
    const visible = text(renderToString(<VoteTargetSummary item={item({ levelNo: 2, totalLevels: 3, levelName: 'Төв', amount: 7_000_000 })} />));
    expect(visible).toContain('LA-2026-000001');
    expect(visible).toContain('Бат Болд');
    expect(visible).toContain('2/3 · Төв');
    expect(visible).toContain('₮');
    expect(visible).toMatch(/7\D?000\D?000/);
  });
  it('дүн, харилцагч байхгүй бол "—" (null, NaN, UUID харагдахгүй)', () => {
    const visible = text(renderToString(<VoteTargetSummary item={item({ amount: null, borrowerName: null })} />));
    expect(visible).toContain('—');
    for (const bad of ['null', 'undefined', 'NaN', ID_1]) expect(visible).not.toContain(bad);
  });
  it('валютыг хүндэтгэнэ (USD)', () => {
    expect(text(renderToString(<VoteTargetSummary item={item({ amount: 1500, currency: 'USD' })} />))).toContain('USD');
  });
});

describe('i18n', () => {
  it('application.error.VOTE_TARGET_CHANGED түлхүүр байна', () => expect(hasMessage('application.error.VOTE_TARGET_CHANGED')).toBe(true));
  it.each(['application.mine.col.level', 'application.mine.col.due', 'application.mine.overdue', 'application.mine.empty', 'application.mine.voteFailed'])(
    '%s түлхүүр монгол текстээр байна',
    (k) => {
      expect(hasMessage(k)).toBe(true);
      expect(t(k)).toMatch(/[Ѐ-ӿ]/);
    },
  );

  it('application.mine.level: түвшний дугаар / нийт / нэрийг орлуулна', () => {
    expect(hasMessage('application.mine.level')).toBe(true);
    expect(t('application.mine.level', { no: 1, total: 2, name: 'Салбарын захирал' })).toBe('1/2 · Салбарын захирал');
  });
});
