import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OcrError } from '../types';
import { buildSyntheticStatementText, FIXTURE_ID_CARD_TEXT, SYNTHETIC_IBAN } from './mock.fixtures';
import { MockOcrProvider } from './mock.provider';
import { isValidIban, parseMnAmount, parseRegisterNo } from '../text';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const rejects = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as OcrError;

describe('MockOcrProvider', () => {
  it('built-in fixture: файлын нэрийн хэсгээр (id-card, salary, statement), том/жижиг үсэг ба _/зай-д мэдрэмжгүй', async () => {
    const p = new MockOcrProvider();
    const idCard = await p.recognize({ content: PNG, mimeType: 'image/png', fileName: 'My_ID-Card scan.PNG' });
    expect(idCard.text).toContain('ИРГЭНИЙ ҮНЭМЛЭХ');
    expect(idCard.engine).toBe('mock');
    expect(idCard.pages).toHaveLength(1);
    const salary = await p.recognize({ content: PNG, mimeType: 'image/png', fileName: 'salary.png' });
    expect(salary.text).toContain('ЦАЛИНГИЙН ТОДОРХОЙЛОЛТ');
    const statement = await p.recognize({ content: PNG, mimeType: 'application/pdf', fileName: 'khan-statement-2026.pdf' });
    expect(statement.text).toContain('Эцсийн үлдэгдэл');
  });

  it('fixture зохиомол ч ЗӨВ бүтэцтэй: регистр, IBAN нь validator-ыг давна; үлдэгдлийн гинж таарна', async () => {
    const stmt = buildSyntheticStatementText();
    expect(isValidIban(SYNTHETIC_IBAN)).toBe(true);
    expect(parseRegisterNo(FIXTURE_ID_CARD_TEXT.match(/[А-Я]{2}\d{8}/)?.[0] ?? '').valid).toBe(true);
    expect(stmt).toContain('SYNTHETIC');
    const rows = stmt.split('\n').filter((l) => /^\d{4}\.\d{2}\.\d{2}\t/.test(l));
    let balance = parseMnAmount(/Эхний үлдэгдэл:\t(.+)/.exec(stmt)?.[1] ?? '') as number;
    for (const row of rows) {
      const [, , , debit, credit, after] = row.split('\t');
      balance += (parseMnAmount(credit) as number) - (parseMnAmount(debit) as number);
      expect(balance).toBeCloseTo(parseMnAmount(after) as number, 2);
    }
    expect(rows.length).toBeGreaterThanOrEqual(8);
  });

  it('deterministic: нэг оролт = яг ижил гаралт, durationMs 0', async () => {
    const p = new MockOcrProvider();
    const input = { content: PNG, mimeType: 'image/png', fileName: 'id-card.png' };
    const [a, b] = [await p.recognize(input), await p.recognize(input)];
    expect(a).toEqual(b);
    expect(a.durationMs).toBe(0);
    expect(a.meanConfidence).toBe(0.99);
  });

  it('fixture-ийн дараалал: sha256 > бүртгэсэн нэрний pattern > text/plain > built-in', async () => {
    const content = Buffer.from('binary-ish');
    const sha = createHash('sha256').update(content).digest('hex');
    const p = new MockOcrProvider({ bySha256: { [sha.toUpperCase()]: 'ХЭШ' } })
      .registerFileName('id-card', 'НЭР-STRING')
      .registerFileName(/^scan-\d+\.png$/, 'НЭР-REGEX');
    expect((await p.recognize({ content, mimeType: 'image/png', fileName: 'id-card.png' })).text).toBe('ХЭШ');
    expect((await p.recognize({ content: PNG, mimeType: 'image/png', fileName: 'ID-CARD.png' })).text).toBe('НЭР-STRING');
    expect((await p.recognize({ content: PNG, mimeType: 'image/png', fileName: 'scan-42.png' })).text).toBe('НЭР-REGEX');
    // text/plain passthrough нь built-in-ээс түрүүлнэ: файлын нэр 'salary' ч агуулга нь өөрөө
    const plain = await p.recognize({ content: Buffer.from('Өөрийн текст'), mimeType: 'text/plain; charset=utf-8', fileName: 'salary.txt' });
    expect(plain.text).toBe('Өөрийн текст');
  });

  it('global RegExp (lastIndex) төлөвөөс хамаарахгүй', async () => {
    const p = new MockOcrProvider().registerFileName(/doc/g, 'X');
    for (let i = 0; i < 3; i++) expect((await p.recognize({ content: PNG, mimeType: 'image/png', fileName: 'doc.png' })).text).toBe('X');
  });

  it('text/plain passthrough: BOM-ыг хасна, TAB-аар баганы цоорхой үүсгэнэ', async () => {
    const p = new MockOcrProvider();
    const r = await p.recognize({ content: Buffer.from('﻿Огноо\tДүн\n2026.03.01\t100'), mimeType: 'text/plain' });
    expect(r.pages[0].lines[0].text).toBe('Огноо Дүн');
    const [w1, w2] = r.pages[0].lines[0].words;
    expect(w2.box.x - (w1.box.x + w1.box.width)).toBeGreaterThanOrEqual(3 * 14);
  });

  it('олон хуудас: pages, текст "\\n\\f"', async () => {
    const r = await new MockOcrProvider().recognize({ content: Buffer.from('нэг\fхоёр'), mimeType: 'text/plain' });
    expect(r.pages.map((p) => p.pageNo)).toEqual([1, 2]);
    expect(r.text).toBe('нэг\n\fхоёр');
  });

  it('алдаа: fixture олдоогүй → NO_FIXTURE; дэмжигдээгүй mime → UNSUPPORTED_MIME; хоосон/том → INVALID_INPUT; хоосон текст → EMPTY_RESULT', async () => {
    const p = new MockOcrProvider({ maxInputBytes: 16 });
    expect((await rejects(p.recognize({ content: PNG, mimeType: 'image/png', fileName: 'unknown.png' }))).code).toBe('NO_FIXTURE');
    expect((await rejects(p.recognize({ content: PNG, mimeType: 'image/gif', fileName: 'id-card.gif' }))).code).toBe('UNSUPPORTED_MIME');
    expect((await rejects(p.recognize({ content: Buffer.alloc(0), mimeType: 'image/png' }))).code).toBe('INVALID_INPUT');
    expect((await rejects(p.recognize({ content: Buffer.alloc(17, 1), mimeType: 'image/png', fileName: 'id-card.png' }))).code).toBe('INVALID_INPUT');
    expect((await rejects(p.recognize({ content: Buffer.from('  \n '), mimeType: 'text/plain' }))).code).toBe('EMPTY_RESULT');
    expect((await rejects(p.recognize({ content: 'x' as unknown as Buffer, mimeType: 'image/png' }))).code).toBe('INVALID_INPUT');
  });

  it('хэлний кодыг provider-той адил шалгана; алдааны мессежид файлын нэр/агуулга орохгүй', async () => {
    const p = new MockOcrProvider();
    const e = await rejects(p.recognize({ content: PNG, mimeType: 'image/png', fileName: 'id-card.png', languages: ['mon', '--oem'] }));
    expect(e.code).toBe('INVALID_INPUT');
    const e2 = await rejects(p.recognize({ content: PNG, mimeType: 'image/png', fileName: 'Дорж-Болд-УБ90010203.png' }));
    expect(e2.code).toBe('NO_FIXTURE');
    expect(e2.message).not.toMatch(/Дорж|УБ9/);
  });

  it('builtins: false бол built-in fixture ашиглахгүй', async () => {
    const p = new MockOcrProvider({ builtins: false });
    expect((await rejects(p.recognize({ content: PNG, mimeType: 'image/png', fileName: 'id-card.png' }))).code).toBe('NO_FIXTURE');
  });

  it('healthCheck ok', async () => {
    expect(await new MockOcrProvider().healthCheck()).toMatchObject({ ok: true });
  });
});
