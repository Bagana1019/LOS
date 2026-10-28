// detect — банкны нэр (толгой хэсэгт, бүтэн үгээр) + бүтцийн тэмдэг. Гүйлгээний утгын нэр оноонд нөлөөлөхгүй. SYNTHETIC.
import { describe, expect, it } from 'vitest';
import type { StatementText } from '../statement.types';
import type { BankProfile } from './bank-profile';
import { ENGINE_DEFAULTS } from './defaults';
import { scoreTableStatement } from './detect';
import { statementTextFromDump } from './text-dump';

const PROFILE: BankProfile = {
  bank: 'TDB',
  parserId: 'detect-test-v1',
  verified: false,
  nameKeywords: ['Тест банк', 'TST'],
  rejectKeywords: ['Тест банк Индия'],
  structuralCues: [/Statement\s+of\s+account/i, /tstbank\.example/i],
  dateOrder: 'DMY',
  hasTime: true,
  acceptsImages: true,
};

const TABLE = ['Огноо\tГүйлгээний утга\tДебит\tКредит\tҮлдэгдэл', '2026-03-01\tЦалин\t0.00\t100.00\t1,100.00'];
const dump = (...head: string[]): StatementText => statementTextFromDump([...head, ...TABLE].join('\n'));
const D = ENGINE_DEFAULTS.detect;

describe('scoreTableStatement', () => {
  it('bank name in the title + table header scores high', () => {
    expect(scoreTableStatement(dump('Тест банк', 'Дансны хуулга'), PROFILE)).toBeGreaterThanOrEqual(D.titleKeyword + D.tableHeader);
  });

  it('the name only deeper in the header zone scores lower than in the title, but still above the "no name" cap', () => {
    const lines = Array.from({ length: ENGINE_DEFAULTS.titleZoneLines + 2 }, (_, i) => `мөр ${i}`);
    const deep = scoreTableStatement(dump(...lines, 'Банк: Тест банк'), PROFILE);
    const title = scoreTableStatement(dump('Тест банк', ...lines), PROFILE);
    expect(deep).toBeLessThan(title);
    expect(deep).toBeGreaterThan(D.noKeywordMax);
  });

  it('without the name the score is capped below the registry minimum, however good the structure', () => {
    const score = scoreTableStatement(
      dump('Дансны хуулга', 'Дансны дугаар: 5011223344', 'Данс эзэмшигч: Дорж Бат', 'Хугацаа: 2026-03-01 - 2026-03-31', 'Эхний үлдэгдэл: 1,000.00', 'Statement of account', 'tstbank.example'),
      PROFILE,
    );
    expect(score).toBeLessThanOrEqual(D.noKeywordMax);
    expect(score).toBeGreaterThan(0);
  });

  it('the name inside a transaction row (after the table started) is ignored', () => {
    const text = statementTextFromDump(['Дансны хуулга', ...TABLE, '2026-03-02\tТест банк руу шилжүүлэг TST\t10.00\t0.00\t1,090.00'].join('\n'));
    expect(scoreTableStatement(text, PROFILE)).toBeLessThanOrEqual(D.noKeywordMax);
  });

  it('whole words only', () => {
    expect(scoreTableStatement(dump('Тестбанкс', 'XTST', 'TSTX'), PROFILE)).toBeLessThanOrEqual(D.noKeywordMax);
    expect(scoreTableStatement(dump('Дансны хуулга - TST'), PROFILE)).toBeGreaterThan(D.noKeywordMax);
  });

  it('a reject keyword makes the score 0', () => {
    expect(scoreTableStatement(dump('Тест банк Индия', 'Дансны хуулга'), PROFILE)).toBe(0);
  });

  it('structural cues and header labels add a little', () => {
    const base = scoreTableStatement(dump('Тест банк'), PROFILE);
    const withCues = scoreTableStatement(dump('Тест банк', 'Statement of account', 'tstbank.example'), PROFILE);
    const withLabels = scoreTableStatement(dump('Тест банк', 'Дансны дугаар: 5011223344', 'Данс эзэмшигч: Дорж Бат'), PROFILE);
    expect(withCues).toBeGreaterThan(base);
    expect(withLabels).toBeGreaterThan(base);
    expect(withCues - base).toBeLessThanOrEqual(D.cueMax * D.cue + 0.011);
  });

  it('the score never exceeds 1', () => {
    const score = scoreTableStatement(
      dump('Тест банк', 'Тест банк', 'Дансны дугаар: 5011223344', 'Данс эзэмшигч: Дорж Бат', 'Эхний үлдэгдэл: 1', 'Эцсийн үлдэгдэл: 2', 'Statement of account', 'tstbank.example'),
      PROFILE,
    );
    expect(score).toBeLessThanOrEqual(1);
  });

  it('empty input, blank pages and garbage give 0', () => {
    expect(scoreTableStatement({ source: 'TEXT', pages: [], meta: statementTextFromDump('').meta }, PROFILE)).toBe(0);
    expect(scoreTableStatement(statementTextFromDump('\n\n  \n'), PROFILE)).toBe(0);
    expect(scoreTableStatement(statementTextFromDump('%%% ### @@@'), PROFILE)).toBe(0);
  });

  it('only the first page matters', () => {
    const text = statementTextFromDump(['Дансны хуулга', ...TABLE].join('\n') + '\f' + 'Тест банк\nТест банк');
    expect(scoreTableStatement(text, PROFILE)).toBeLessThanOrEqual(D.noKeywordMax);
  });

  it('scores are rounded to two decimals', () => {
    const s = scoreTableStatement(dump('Тест банк', 'Дансны дугаар: 5011223344'), PROFILE);
    expect(Math.round(s * 100) / 100).toBe(s);
  });

  it('a very long first line does not hang', () => {
    const t = Date.now();
    scoreTableStatement(dump('Тест '.repeat(200_000)), PROFILE);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
