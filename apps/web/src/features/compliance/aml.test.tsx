import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AmlHit, AmlHitQueueItem, AmlScreeningDetail } from '@los/contracts';
import { API, ApiError } from '../../lib/api';
import { messageKeys } from '../../lib/i18n';
import { textOfTestId, visibleText } from '../collateral/html.fixtures';
import { describeApplicationError } from '../applications/applications.utils';
import { fetchAmlQueue, fetchAmlScreening, reviewAmlHit } from './aml.api';
import { describeAmlReviewError, reviewConfirmCopy, screeningHref, validateReviewReason } from './aml.utils';
import { AmlQueueView } from './AmlQueueView';
import { AmlScreeningView } from './AmlScreeningView';

// docs/05-compliance-aml.md §5, §7 — Compliance · AML шалгалт: дараалал, дэлгэрэнгүй (hit ↔ харилцагч зэрэгцүүлэн), шийдвэрийн маягт.

const REGISTER_FULL = 'ХИ87654321';
const makeHit = (over: Partial<AmlHit> = {}): AmlHit => ({
  id: 'hit-1', list: 'UN_SC', matchType: 'NAME_FUZZY', score: 0.9312, severity: 'BLOCKING', status: 'OPEN', entryRef: 'FIXTURE-UN-001', entryName: 'GANBOLD Bat-Erdene',
  matchedValue: 'GANBOLD Bat-Erdene', listVersion: 'un-v1', reviewedBy: null, reviewedAt: null, reviewComment: null,
  details: { programme: 'DPRK', listedOn: '2020-01-01', partyType: 'INDIVIDUAL', matchedName: 'GANBOLD Bat-Erdene', subjectName: 'Ганболд Бат-Эрдэнэ', dateOfBirth: 'MISMATCH', nationalities: ['KP'] },
  ...over,
});
const makeDetail = (over: Partial<AmlScreeningDetail> = {}): AmlScreeningDetail => ({
  id: 'scr-1', orgId: 'org-1', customerId: 'cust-1', applicationId: 'app-1', trigger: 'APPLICATION', status: 'REVIEW_REQUIRED', blocking: true,
  riskScore: 60, riskLevel: 'HIGH', riskFactors: [], subjectName: 'Ганболд Бат-Эрдэнэ', registerNoMasked: '*******321', hits: [makeHit()],
  listVersions: { UN_SC: 'un-v1', FATF: 'f-1', INTERNAL_BLACKLIST: 'live' }, screenedAt: '2026-10-28T09:00:00.000Z', screenedBy: 'officer-1',
  subject: { subjectType: 'INDIVIDUAL', lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ', aliases: ['Bat Erdene'], birthYear: 1980, countries: ['MN'], isPep: false, isRelatedParty: false },
  ...over,
});
const makeItem = (over: Partial<AmlHitQueueItem['hit']> = {}): AmlHitQueueItem => ({
  hit: makeHit(over),
  screening: { id: 'scr-1', customerId: 'cust-1', applicationId: 'app-1', status: 'REVIEW_REQUIRED', subjectName: 'Ганболд Бат-Эрдэнэ', registerNoMasked: '*******321', screenedAt: '2026-10-28T09:00:00.000Z' },
});

describe('aml.utils', () => {
  it('reason is mandatory: empty/blank, under 5 or over 2000 characters (after trim) is rejected with a Mongolian message', () => {
    expect(validateReviewReason('')).toBe('Шийдвэрийн тайлбар заавал');
    expect(validateReviewReason('     ')).toBe('Шийдвэрийн тайлбар заавал');
    expect(validateReviewReason(' abcd ')).toBe('Тайлбар хамгийн багадаа 5 тэмдэгт');
    expect(validateReviewReason('x'.repeat(2001))).toBe('Тайлбар 2000 тэмдэгтээс ихгүй');
    expect(validateReviewReason('  Төрсөн он зөрүүтэй  ')).toBeNull();
    expect(validateReviewReason('x'.repeat(2000))).toBeNull();
  });
  it('maps review errors to Mongolian messages (self-review, already decided, superseded, forbidden)', () => {
    expect(describeAmlReviewError(new ApiError(403, 'FORBIDDEN', 'The reviewer must differ from the user who requested the screening'))).toBe('Шалгалтыг эхлүүлсэн хэрэглэгч өөрөө шийдвэрлэх боломжгүй (4 нүдний зарчим)');
    expect(describeAmlReviewError(new ApiError(403, 'FORBIDDEN', 'Insufficient role'))).toBe('AML тохирлыг шийдвэрлэх эрхгүй байна');
    expect(describeAmlReviewError(new ApiError(409, 'CONFLICT', 'Hit has already been reviewed'))).toBe('Энэ тохирлыг өөр хэрэглэгч аль хэдийн шийдвэрлэсэн байна');
    expect(describeAmlReviewError(new ApiError(409, 'CONFLICT', 'Screening is superseded by a newer one; review the hits of the latest screening'))).toBe('Харилцагчийг дахин шалгасан тул шинэ шалгалтын тохирлыг шийдвэрлэнэ үү');
    expect(describeAmlReviewError(new ApiError(404, 'NOT_FOUND', 'Hit not found'))).toBe('Тохирол олдсонгүй');
    expect(describeAmlReviewError(new Error('boom'))).toBe('Шийдвэр хадгалж чадсангүй');
  });
  it('screeningHref encodes the id', () => expect(screeningHref('a/b')).toBe('/los/compliance/aml/a%2Fb'));
  it('F7-2: the confirmation copy names the decision and explains the consequence of each outcome', () => {
    expect(reviewConfirmCopy('FALSE_POSITIVE')).toEqual({ decision: 'Худал тохирол', consequence: expect.stringContaining('хаалт нээгдэнэ') });
    expect(reviewConfirmCopy('CONFIRMED')).toEqual({ decision: 'Жинхэнэ тохирол', consequence: expect.stringContaining('хаалт хэвээр') });
  });
});

describe('AML_REVIEW_REQUIRED on the application page', () => {
  it('says the application awaits compliance review (Mongolian)', () => {
    const msg = describeApplicationError(new ApiError(422, 'AML_REVIEW_REQUIRED', 'AML review required'), 'application.submit.failed');
    expect(msg).toBe('Хүсэлт комплаенсын AML шалгалтыг хүлээж байна — комплаенсын ажилтан тохирлыг шийдвэрлэсний дараа дахин илгээнэ үү');
    expect(describeApplicationError(new ApiError(422, 'AML_CONFIRMED_MATCH', 'x'), 'application.submit.failed')).toContain('баталгаажсан тохирол');
  });
});

describe('aml.api (web → gateway `/kyc/aml/*` only)', () => {
  let calls: Array<{ url: string; method: string; body: unknown }>;
  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      const payload = url.includes('/review') || url.includes('/screenings/') ? makeDetail() : { total: 1, items: [makeItem()] };
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('queue, detail and decision paths', async () => {
    expect((await fetchAmlQueue({ limit: 20, offset: 40 })).total).toBe(1);
    expect((await fetchAmlScreening('scr 1')).subject.birthYear).toBe(1980);
    await reviewAmlHit('hit-1', { decision: 'FALSE_POSITIVE', comment: 'Өөр хүн' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/kyc/aml/hits?status=OPEN&limit=20&offset=40`,
      `GET ${API}/kyc/aml/screenings/scr%201`,
      `POST ${API}/kyc/aml/hits/hit-1/review`,
    ]);
    expect(calls[2]!.body).toEqual({ decision: 'FALSE_POSITIVE', comment: 'Өөр хүн' });
  });
});

describe('AmlQueueView', () => {
  const render = (items: AmlHitQueueItem[], total = items.length) =>
    renderToString(<AmlQueueView items={items} total={total} page={1} pageSize={20} loading={false} error={null} onPageChange={() => undefined} />);

  it('lists open hits with the masked register, list, severity, score and a link to the screening', () => {
    const html = render([makeItem()]);
    const text = visibleText(html);
    expect(text).toContain('Compliance · AML шалгалт');
    expect(text).toContain('Ганболд Бат-Эрдэнэ');
    expect(text).toContain('*******321');
    expect(text).toContain('НҮБ-ын хориг');
    expect(text).toContain('Хаах');
    expect(text).toContain('93%');
    expect(html).toContain('href="/los/compliance/aml/scr-1"');
    expect(html).not.toContain(REGISTER_FULL);
  });
  it('empty queue → explicit empty message', () => {
    expect(visibleText(render([]))).toContain('Шийдвэрлэх тохирол алга');
  });
  it('load error is shown as an alert', () => {
    const html = renderToString(<AmlQueueView items={[]} total={0} page={1} pageSize={20} loading={false} error={new ApiError(403, 'FORBIDDEN', 'Insufficient role')} onPageChange={() => undefined} />);
    expect(html).toContain('role="alert"');
    expect(visibleText(html)).toContain('AML тохирлыг шийдвэрлэх эрхгүй байна');
  });
});

describe('AmlScreeningView', () => {
  const render = (detail = makeDetail(), currentUserId = 'compliance-1') =>
    renderToString(<AmlScreeningView detail={detail} currentUserId={currentUserId} submittingHitId={null} onReview={() => undefined} />);

  it('shows the customer side by side with the list entry (name, birth year vs DOB evidence, countries vs nationalities)', () => {
    const html = render();
    const subject = textOfTestId(html, 'aml-subject') ?? '';
    expect(subject).toContain('Ганболд Бат-Эрдэнэ');
    expect(subject).toContain('*******321');
    expect(subject).toContain('1980');
    expect(subject).toContain('MN');
    expect(subject).toContain('Bat Erdene');
    const hit = textOfTestId(html, 'aml-hit-hit-1') ?? '';
    expect(hit).toContain('GANBOLD Bat-Erdene');
    expect(hit).toContain('FIXTURE-UN-001');
    expect(hit).toContain('DPRK');
    expect(hit).toContain('KP');
    expect(hit).toContain('Төрсөн он зөрүүтэй');
    expect(hit).toContain('Харилцагч');
    expect(hit).toContain('Жагсаалтын бүртгэл');
    expect(html).not.toContain(REGISTER_FULL);
  });
  it('open hit → decision form with both outcomes and a mandatory reason', () => {
    const form = textOfTestId(render(), 'aml-review-hit-1') ?? '';
    expect(form).toContain('Худал тохирол');
    expect(form).toContain('Жинхэнэ тохирол');
    expect(form).toContain('Шийдвэрийн тайлбар');
    expect(form).toContain('Шийдвэр хадгалах');
  });
  it('reviewed hit → shows the decision, reviewer and reason instead of a form', () => {
    const reviewed = makeHit({ status: 'FALSE_POSITIVE', reviewedBy: 'compliance-2', reviewedAt: '2026-10-28T10:00:00.000Z', reviewComment: 'Өөр хүн, төрсөн он зөрүүтэй' });
    const html = render(makeDetail({ status: 'CLEARED_AFTER_REVIEW', blocking: false, hits: [reviewed] }));
    expect(textOfTestId(html, 'aml-review-hit-1')).toBeNull();
    const hit = textOfTestId(html, 'aml-hit-hit-1') ?? '';
    expect(hit).toContain('Худал тохирол');
    expect(hit).toContain('compliance-2');
    expect(hit).toContain('Өөр хүн, төрсөн он зөрүүтэй');
    expect(visibleText(html)).toContain('Шалгалтын дараа цэвэрлэгдсэн');
  });
  it('four-eyes: the user who requested the screening sees a notice instead of the form', () => {
    const html = render(makeDetail(), 'officer-1');
    expect(textOfTestId(html, 'aml-review-hit-1')).toBeNull();
    expect(visibleText(html)).toContain('Шалгалтыг эхлүүлсэн хэрэглэгч өөрөө шийдвэрлэх боломжгүй');
  });
});

describe('i18n: every literal `aml.*` key used in the compliance feature exists', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const dictionary = new Set(messageKeys());
  it('literal keys', () => {
    const files = readdirSync(here).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
    expect(files.length).toBeGreaterThan(3);
    const missing: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(join(here, f), 'utf8').matchAll(/['"`]((?:aml|nav)\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) {
        if (!dictionary.has(m[1]!)) missing.push(`${m[1]} (${f})`);
      }
    }
    expect(missing).toEqual([]);
    expect(dictionary.has('nav.aml_review')).toBe(true);
  });
});
