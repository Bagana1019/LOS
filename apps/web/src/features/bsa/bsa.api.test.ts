import { describe, expect, it } from 'vitest';
import { toAnalysisBrief } from './bsa.api';

// Регресс: scoring-ийн хариу `{ analysis: { status } }` — өмнө нь UI `status`-ыг дээд түвшинд хайж «Хуулга оруулах» товч үргэлж идэвхгүй байсан.
describe('toAnalysisBrief', () => {
  it('flattens the scoring overview so a DRAFT analysis is detected', () => {
    const b = toAnalysisBrief({ analysis: { id: 'a1', applicationId: 'app1', status: 'DRAFT', version: 2 }, summary: null });
    expect(b).toMatchObject({ id: 'a1', status: 'DRAFT', version: 2, applicationId: 'app1', summary: null });
  });

  // F6-14: хураангуйн таб анхааруулга, аргачлал, задаргааг энэ хариунаас авдаг — алдагдах ёсгүй.
  it('carries the warnings, details and stale flag the summary tab renders, with safe defaults when absent', () => {
    const base = { analysis: { id: 'a1', applicationId: 'app1', status: 'DRAFT' as const, version: 1 }, summary: null };
    const warning = { code: 'COVERAGE_SHORTFALL', message: '2 сарын хуулга дутуу байна.', severity: 'WARNING' as const, scope: 'ANALYSIS' as const };
    expect(toAnalysisBrief({ ...base, warnings: [warning], summaryStale: true })).toMatchObject({ warnings: [warning], summaryStale: true, details: null });
    expect(toAnalysisBrief(base)).toMatchObject({ warnings: [], summaryStale: false, details: null });
  });
});
