import { describe, expect, it } from 'vitest';
import { demoLoanContractDocx, demoOfficialLetterDocx } from './demo-template';
import { docxBlocks } from './docx-blocks';
import { extractPlaceholders, fillDocx } from './docx-renderer';
import { PdfLibConverter } from './pdf-converter';
import { PLACEHOLDER_CATALOG } from '@los/contracts';

const schedule = Array.from({ length: 36 }, (_, i) => ({ no: i + 1, due_date: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`, principal: '700,000', interest: '476,828', total: '1,176,828', balance: String(30_000_000 - 700_000 * (i + 1)) }));
const data = { contract_no: 'C-2026-0001', borrower_name: 'Бат-Эрдэнэ Дорж', approved_amount: '30,000,000', currency: 'MNT', schedule, org_name: 'Радикс ББСБ' };

describe('docx template (FR-11.1/11.2)', () => {
  it('extracts placeholders; DEMO templates only use catalog keys', () => {
    const keys = extractPlaceholders(demoLoanContractDocx());
    expect(keys).toContain('borrower_name');
    expect(keys).toContain('schedule');
    const known = new Set(PLACEHOLDER_CATALOG.map((p) => p.key));
    expect(keys.filter((k) => !known.has(k) && !['no', 'due_date', 'principal', 'interest', 'total', 'balance'].includes(k))).toEqual([]);
    expect(extractPlaceholders(demoOfficialLetterDocx())).toContain('letter_no');
  });

  it('fills fields and repeats the schedule row', () => {
    const blocks = docxBlocks(fillDocx(demoLoanContractDocx(), data));
    const text = blocks.filter((b) => b.kind === 'p').map((b) => (b as { text: string }).text).join('\n');
    expect(text).toContain('Бат-Эрдэнэ Дорж');
    expect(text).toContain('30,000,000 MNT');
    expect(text).not.toContain('{{');
    const table = blocks.find((b) => b.kind === 'table') as { rows: string[][] };
    expect(table.rows).toHaveLength(1 + 36); // толгой + 36 мөр
    expect(table.rows[36]![5]).toBe('4800000');
  });

  it('rejects a non-docx buffer', () => {
    expect(() => extractPlaceholders(Buffer.from('nope'))).toThrow(/docx/);
  });

  it('converts to a multi-page PDF with Cyrillic text', async () => {
    const pdf = await new PdfLibConverter().convert(fillDocx(demoLoanContractDocx(), data));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const { PDFDocument } = await import('pdf-lib');
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(1);
  });
});
