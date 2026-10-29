// text-dump — fixture-ийн .txt dump ↔ StatementText. SYNTHETIC.
import { describe, expect, it } from 'vitest';
import { statementTextFromDump, statementTextToDump, syntheticMeta } from './text-dump';

describe('statementTextFromDump', () => {
  it('pages split on form feed, lines on newline (CRLF and CR too), cells on TAB', () => {
    const t = statementTextFromDump('a\tb\r\nc d\n\fp2 line');
    expect(t.pages).toHaveLength(2);
    expect(t.pages[0].pageNo).toBe(1);
    expect(t.pages[1].pageNo).toBe(2);
    expect(t.pages[0].lines[0]).toEqual({ text: 'a b', cells: ['a', 'b'] });
    expect(t.pages[0].lines[1]).toEqual({ text: 'c d', cells: ['c d'] });
    expect(t.pages[1].lines[0].text).toBe('p2 line');
  });

  it('empty cells are kept in cells but not in text', () => {
    expect(statementTextFromDump('a\t\tb').pages[0].lines[0]).toEqual({ text: 'a b', cells: ['a', '', 'b'] });
  });

  it('uses the given source and meta', () => {
    const t = statementTextFromDump('x', { source: 'CSV', meta: { fileName: 'f.csv', mimeType: 'text/csv' } });
    expect(t.source).toBe('CSV');
    expect(t.meta).toMatchObject({ fileName: 'f.csv', mimeType: 'text/csv', sizeBytes: 0 });
  });

  it('empty dump is one page with one empty line', () => {
    const t = statementTextFromDump('');
    expect(t.pages).toHaveLength(1);
    expect(t.pages[0].lines).toHaveLength(1);
  });
});

describe('statementTextToDump', () => {
  it('round-trips a dump', () => {
    const dump = 'Хаан банк\nОгноо\tУтга\tДүн\n2026-03-01\tЦалин\t1,000.00\n\fХуудас 2\n2026-03-02\t\t5.00';
    expect(statementTextToDump(statementTextFromDump(dump))).toBe(dump);
  });
});

describe('syntheticMeta', () => {
  it('is marked as a synthetic text file and can be overridden', () => {
    expect(syntheticMeta()).toMatchObject({ fileName: 'dump.txt', mimeType: 'text/plain', sizeBytes: 0 });
    expect(syntheticMeta({ sizeBytes: 5 }).sizeBytes).toBe(5);
  });
});
