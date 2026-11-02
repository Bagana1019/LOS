import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationStatus, StepKey, type ApplicationStepView } from '@los/contracts';
import { API } from '../../lib/api';
import { hasMessage } from '../../lib/i18n';
import * as api from './applications.api';
import { describeApplicationError, isStepOpen, resumeStep, STATUS_TABS, stepHref } from './applications.utils';

const here = fileURLToPath(new URL('.', import.meta.url));

const step = (stepKey: StepKey, status: ApplicationStepView['status'], stage: 1 | 2 = 1): ApplicationStepView => ({ stepKey, stage, order: 1, status, required: true, completedAt: null, staleReason: null });

describe('төлөв, алхам', () => {
  it('табууд төлөвтэй 1:1 (9 таб), бүгд монгол нэртэй', () => {
    expect(STATUS_TABS).toEqual(ApplicationStatus);
    for (const s of ApplicationStatus) expect(hasMessage(`status.${s}`), s).toBe(true);
  });
  it('12 алхам бүр нэртэй, төлөв бүр тайлбартай', () => {
    for (const k of StepKey) expect(hasMessage(`application.step.${k}`), k).toBe(true);
    for (const s of ['LOCKED', 'PENDING', 'COMPLETED', 'STALE']) expect(hasMessage(`application.stepStatus.${s}`), s).toBe(true);
  });
  it('resumeStep: эхний бүрдээгүй 1-р үе шатны алхам; бүгд бүрдсэн бол шийдвэр', () => {
    expect(resumeStep([step('client', 'COMPLETED'), step('inquiry', 'PENDING'), step('income', 'PENDING')])).toBe('inquiry');
    expect(resumeStep([step('client', 'COMPLETED'), step('inquiry', 'STALE')])).toBe('inquiry');
    expect(resumeStep([step('client', 'COMPLETED'), step('contract', 'PENDING', 2)])).toBe('decision');
  });
  it('isStepOpen: LOCKED бол хаалттай', () => {
    expect(isStepOpen({ steps: [step('contract', 'LOCKED', 2)] }, 'contract')).toBe(false);
    expect(isStepOpen({ steps: [step('client', 'PENDING')] }, 'client')).toBe(true);
  });
  it('stepHref', () => expect(stepHref('a/b', 'client')).toBe('/los/loan-application/a%2Fb/client'));
  it('алдааны текст: мэдэгдэж буй код → i18n, үгүй бол fallback', () => {
    expect(describeApplicationError(new Error('x'), 'application.create.failed')).toBe('Хүсэлт үүсгэж чадсангүй');
  });
});

describe('gateway зам (`/api/origination/applications…`)', () => {
  let urls: Array<{ url: string; method?: string }>;
  beforeEach(() => {
    urls = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      urls.push({ url, method: init?.method });
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each<[string, () => Promise<unknown>, string, string]>([
    ['list', () => api.fetchApplications({ status: 'DRAFT', page: 2 }), '/applications?status=DRAFT&page=2', 'GET'],
    ['detail', () => api.fetchApplication('a1'), '/applications/a1', 'GET'],
    ['history', () => api.fetchApplicationHistory('a1'), '/applications/a1/history', 'GET'],
    ['create', () => api.createApplication({}), '/applications', 'POST'],
    ['submit', () => api.transitionApplication('a1', { to: 'SUBMITTED' }), '/applications/a1/transition', 'POST'],
  ])('%s', async (_n, call, path, method) => {
    await call();
    expect(urls[0].url).toBe(`${API}/origination${path}`);
    expect((urls[0].method ?? 'GET').toUpperCase()).toBe(method);
  });
});

describe('эх кодонд бичсэн application.* түлхүүр бүр толь бичигт байна', () => {
  const files = readdirSync(here).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
  it('literal түлхүүр', () => {
    const missing: string[] = [];
    for (const f of files) for (const m of readFileSync(join(here, f), 'utf8').matchAll(/['"`](application\.[A-Za-z0-9_.]*[A-Za-z0-9_])['"`]/g)) if (!hasMessage(m[1] as string)) missing.push(`${f}: ${m[1]}`);
    expect(missing).toEqual([]);
  });
});
