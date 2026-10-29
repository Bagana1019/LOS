import { describe, expect, it } from 'vitest';
import { CsvFormatError, CsvRowLimitError, parseBlacklistCsv } from './csv';

const HEADER = 'registerNo,customerType,name,listType,reasonCode,reasonText';

describe('parseBlacklistCsv', () => {
  it('parses rows keyed by column name with 1-based data row numbers', () => {
    const rows = parseBlacklistCsv(`${HEADER}\nУБ12345678,INDIVIDUAL,Бат,DELINQUENT,LATE,Late payer\nАА87654321,INDIVIDUAL,Сараа,FRAUD,FAKE_DOCS,`);
    expect(rows).toEqual([
      { row: 1, data: { registerNo: 'УБ12345678', customerType: 'INDIVIDUAL', name: 'Бат', listType: 'DELINQUENT', reasonCode: 'LATE', reasonText: 'Late payer' } },
      { row: 2, data: { registerNo: 'АА87654321', customerType: 'INDIVIDUAL', name: 'Сараа', listType: 'FRAUD', reasonCode: 'FAKE_DOCS' } },
    ]);
  });

  it('tolerates UTF-8 BOM and CRLF line endings', () => {
    const rows = parseBlacklistCsv(`\uFEFF${HEADER}\r\nУБ1,INDIVIDUAL,Бат,,LATE,\r\nУБ2,LEGAL_ENTITY,Ордон ХХК,,LATE,\r\n`);
    expect(rows.map((r) => 'data' in r && r.data.registerNo)).toEqual(['УБ1', 'УБ2']);
  });

  it('handles quoted fields with commas, escaped quotes and embedded newlines', () => {
    const [row] = parseBlacklistCsv(`${HEADER}\nУБ1,INDIVIDUAL,"Бат, ""Болд""",DELINQUENT,LATE,"line1\nline2"`);
    expect(row).toEqual({ row: 1, data: { registerNo: 'УБ1', customerType: 'INDIVIDUAL', name: 'Бат, "Болд"', listType: 'DELINQUENT', reasonCode: 'LATE', reasonText: 'line1\nline2' } });
  });

  it('auto-detects the semicolon delimiter from the header and keeps commas in values', () => {
    const [row] = parseBlacklistCsv('registerNo;customerType;name;listType;reasonCode;reasonText\nУБ1;INDIVIDUAL;Бат, Болд;DELINQUENT;LATE;note');
    expect(row).toMatchObject({ data: { name: 'Бат, Болд', reasonText: 'note' } });
  });

  it('skips blank lines and all-empty records without counting them as data rows', () => {
    const rows = parseBlacklistCsv(`\n${HEADER}\n\nУБ1,INDIVIDUAL,Бат,,LATE,\n,,,,,\n   \nУБ2,INDIVIDUAL,Дорж,,LATE,\n`);
    expect(rows.map((r) => r.row)).toEqual([1, 2]);
  });

  it('matches header names case-insensitively, in any order, with optional columns omitted', () => {
    const [row] = parseBlacklistCsv(' NAME ,ReasonCode,CUSTOMERTYPE,registerno\nБат,LATE,INDIVIDUAL,УБ1');
    expect(row).toEqual({ row: 1, data: { name: 'Бат', reasonCode: 'LATE', customerType: 'INDIVIDUAL', registerNo: 'УБ1' } });
  });

  it('ignores a nameless trailing header column produced by a trailing delimiter', () => {
    const [row] = parseBlacklistCsv(`${HEADER},\nУБ1,INDIVIDUAL,Бат,,LATE,,`);
    expect(row).toMatchObject({ row: 1, data: { registerNo: 'УБ1' } });
  });

  it('reports a row with more non-empty cells than the header as a row error, not a batch failure', () => {
    const rows = parseBlacklistCsv(`${HEADER}\nУБ1,INDIVIDUAL,Бат, Болд,DELINQUENT,LATE,note,extra\nУБ2,INDIVIDUAL,Дорж,,LATE,`);
    expect(rows[0]).toEqual({ row: 1, error: 'Row has more columns than the header' });
    expect(rows[1]).toMatchObject({ row: 2, data: { registerNo: 'УБ2' } });
  });

  it('returns no rows for a header-only file', () => {
    expect(parseBlacklistCsv(`${HEADER}\n`)).toEqual([]);
  });

  it.each([
    ['empty input', '', 'header row is required'],
    ['only blank lines', '\n\r\n  \n', 'header row is required'],
    ['missing required column', 'registerNo,name\nУБ1,Бат', 'Missing required column(s): customerType, reasonCode'],
    ['unknown column', `${HEADER},nickname\n`, '1 unknown column(s) in the header row; allowed columns: registerNo, customerType, name, listType, reasonCode, reasonText'],
    ['duplicate column', `${HEADER},name\n`, 'Duplicate column'],
    ['unterminated quote', `${HEADER}\nУБ1,INDIVIDUAL,"Бат,DELINQUENT,LATE,`, 'Unterminated quoted field'],
  ])('rejects the whole file on %s', (_name, text, message) => {
    expect(() => parseBlacklistCsv(text)).toThrow(CsvFormatError);
    expect(() => parseBlacklistCsv(text)).toThrow(message);
  });

  it('does not echo cell values (register numbers) in format errors', () => {
    const messages = ['registerNo,name\nУБ99999999,Бат', 'registerNo,customerType,name,reasonCode\nУБ99999999,"Бат'].map((text) => {
      try {
        parseBlacklistCsv(text);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(messages.every((m) => m.length > 0 && !m.includes('УБ99999999'))).toBe(true);
  });

  // CLAUDE.md 6.5: header-гүй файлын эхний өгөгдлийн мөр (регистр, нэр) header болж задрах тул алдаанд echo хийхгүй.
  it('does not echo header cells when the file has no header row: only the count and the allowed column names', () => {
    const text = 'УБ12345678,INDIVIDUAL,Бат Болд,DELINQUENT,LATE_PAYMENT\nАА87654321,INDIVIDUAL,Сараа,FRAUD,FAKE_DOCS\n';
    let message = '';
    try {
      parseBlacklistCsv(text);
    } catch (e) {
      expect(e).toBeInstanceOf(CsvFormatError);
      message = (e as Error).message;
    }
    expect(message).toBe('5 unknown column(s) in the header row; allowed columns: registerNo, customerType, name, listType, reasonCode, reasonText');
    for (const cell of ['УБ12345678', 'Бат', 'Болд', 'DELINQUENT', 'LATE_PAYMENT']) expect(message).not.toContain(cell);
  });

  // Талбарын дундах (эхэнд биш) хашилт энгийн тэмдэгт: "fresh" логик уствал талбар хашилт нээж, үлдсэн мөрийг залгина.
  describe('quotes, BOM and line endings', () => {
    const row = (cells: string) => parseBlacklistCsv(`${HEADER}\n${cells}`);

    it('treats a quote in the middle of an unquoted field as a literal character', () => {
      expect(row('УБ1,INDIVIDUAL,O"Brien,DELINQUENT,LATE,note')).toEqual([
        { row: 1, data: { registerNo: 'УБ1', customerType: 'INDIVIDUAL', name: 'O"Brien', listType: 'DELINQUENT', reasonCode: 'LATE', reasonText: 'note' } },
      ]);
      expect(row('УБ1,INDIVIDUAL,5" pipe,,LATE,"say ""hi"""')).toMatchObject([{ data: { name: '5" pipe', reasonText: 'say "hi"' } }]);
    });

    it('opens a quoted field only at the start of a field (a quote after leading spaces stays literal)', () => {
      expect(row('УБ1,INDIVIDUAL, "Бат",,LATE,')).toMatchObject([{ data: { name: '"Бат"' } }]);
    });

    it('strips the BOM before a quoted first header cell', () => {
      const header = HEADER.split(',').map((h) => `"${h}"`).join(',');
      expect(parseBlacklistCsv(`\uFEFF${header}\nУБ1,INDIVIDUAL,Бат,,LATE,`)).toEqual([
        { row: 1, data: { registerNo: 'УБ1', customerType: 'INDIVIDUAL', name: 'Бат', reasonCode: 'LATE' } },
      ]);
    });

    it('splits records on CRLF, LF and a bare CR, and keeps CRLF and LF verbatim inside a quoted field', () => {
      const rows = parseBlacklistCsv(`${HEADER}\r\nУБ1,INDIVIDUAL,"a\r\nb",,LATE,\rУБ2,INDIVIDUAL,"c\nd",,LATE,\nУБ3,INDIVIDUAL,e,,LATE,\r\n`);
      expect(rows.map((r) => 'data' in r && r.data.name)).toEqual(['a\r\nb', 'c\nd', 'e']);
      expect(rows.map((r) => r.row)).toEqual([1, 2, 3]);
    });

    it('does not leave a carriage return on the last cell of a CRLF file', () => {
      const [parsed] = parseBlacklistCsv(`${HEADER}\r\nУБ1,INDIVIDUAL,Бат,,LATE,note\r\n`);
      expect(parsed).toMatchObject({ data: { reasonText: 'note' } });
      expect(JSON.stringify(parsed)).not.toContain('\\r');
    });

    it('treats a quoted empty field like an unquoted empty one (the column is omitted)', () => {
      expect(row('УБ1,INDIVIDUAL,Бат,"",LATE,""')).toEqual([{ row: 1, data: { registerNo: 'УБ1', customerType: 'INDIVIDUAL', name: 'Бат', reasonCode: 'LATE' } }]);
    });
  });

  it('parses 5000 rows quickly', () => {
    const body = Array.from({ length: 5000 }, (_, i) => `УБ${String(i).padStart(8, '0')},INDIVIDUAL,Name ${i},DELINQUENT,LATE,text`).join('\n');
    const t = Date.now();
    expect(parseBlacklistCsv(`${HEADER}\n${body}`)).toHaveLength(5000);
    expect(Date.now() - t).toBeLessThan(1000);
  });

  // [19] Мөрийн дээд хязгаарыг задлах явцад мөрдөнө (өмнө нь бүх файлыг задалж дууссаны дараа шалгадаг байв).
  describe('row limit while parsing', () => {
    const dataRows = (n: number) => Array.from({ length: n }, (_, i) => `УБ${String(i).padStart(8, '0')},INDIVIDUAL,N,,C,`).join('\n');

    it('accepts exactly maxRows data rows and rejects one more with CsvRowLimitError', () => {
      expect(parseBlacklistCsv(`${HEADER}\n${dataRows(3)}`, 3)).toHaveLength(3);
      expect(() => parseBlacklistCsv(`${HEADER}\n${dataRows(4)}`, 3)).toThrow(CsvRowLimitError);
      expect(() => parseBlacklistCsv(`${HEADER}\n${dataRows(4)}`, 3)).toThrow('more than 3 data rows');
    });

    it('does not count the header, blank lines or all-empty records', () => {
      const text = `\n${HEADER}\n\nУБ1,INDIVIDUAL,Бат,,LATE,\n,,,,,\n   \nУБ2,INDIVIDUAL,Дорж,,LATE,\n\n\n`;
      expect(parseBlacklistCsv(text, 2)).toHaveLength(2);
      expect(() => parseBlacklistCsv(text, 1)).toThrow(CsvRowLimitError);
    });

    it('is unlimited by default and maxRows 0 allows a header-only file', () => {
      expect(parseBlacklistCsv(`${HEADER}\n${dataRows(50)}`)).toHaveLength(50);
      expect(parseBlacklistCsv(`${HEADER}\n`, 0)).toEqual([]);
      expect(() => parseBlacklistCsv(`${HEADER}\n${dataRows(1)}`, 0)).toThrow(CsvRowLimitError);
    });

    it('stops at maxRows + 1 records: 5 MB of "a\\n" lines is rejected fast with bounded heap growth', () => {
      const text = 'a\n'.repeat((5 * 1024 * 1024) / 2);
      expect(text.charCodeAt(text.length - 1)).toBe(10); // rope-ийг flatten хийж, хэмжилтээс гаргана
      const heapBefore = process.memoryUsage().heapUsed;
      const t = Date.now();

      expect(() => parseBlacklistCsv(text, 5000)).toThrow(CsvRowLimitError);

      expect(Date.now() - t).toBeLessThan(1000);
      expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(100 * 1024 * 1024);
    });

    it('rejects a 5 MB file of valid rows after reading only the first maxRows + 1', () => {
      const row = 'УБ12345678,INDIVIDUAL,Name,,C,\n';
      const text = `${HEADER}\n${row.repeat(Math.ceil((5 * 1024 * 1024) / row.length))}`;
      const t = Date.now();
      expect(() => parseBlacklistCsv(text, 5000)).toThrow(CsvRowLimitError);
      expect(Date.now() - t).toBeLessThan(1000);
    });
  });
});
