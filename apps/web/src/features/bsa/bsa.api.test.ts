import { describe, expect, it } from 'vitest';
import { toAnalysisBrief } from './bsa.api';

// Регресс: scoring-ийн хариу `{ analysis: { status } }` — өмнө нь UI `status`-ыг дээд түвшинд хайж «Хуулга оруулах» товч үргэлж идэвхгүй байсан.
describe('toAnalysisBrief', () => {
  it('flattens the scoring overview so a DRAFT analysis is detected', () => {
    const b = toAnalysisBrief({ analysis: { id: 'a1', applicationId: 'app1', status: 'DRAFT', version: 2 }, summary: null });
    expect(b).toEqual({ id: 'a1', status: 'DRAFT', version: 2, applicationId: 'app1', summary: null });
  });
});
