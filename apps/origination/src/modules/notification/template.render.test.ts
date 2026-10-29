import { describe, expect, it } from 'vitest';
import { escapeHtml, extractPlaceholders, findInvalidPlaceholders, formatAmount, renderText, smsSegments, textToHtml } from './template.render';

describe('renderText', () => {
  it('placeholder-ийг утгаар солино, зай зөвшөөрнө', () => {
    expect(renderText('Сайн уу {{borrowerName}}, {{ contractNo }}', { borrowerName: 'Болд', contractNo: 'B-1' })).toBe('Сайн уу Болд, B-1');
  });
  it('үл мэдэгдэх placeholder болон утгагүй placeholder → хоосон', () => {
    expect(renderText('a{{nope}}b{{comment}}c{{dueDate}}', { comment: null })).toBe('abc');
  });
  it('amount тоо бол мянгатын таслалтай; текст бол хэвээр', () => {
    expect(renderText('{{amount}} {{currency}}', { amount: 1_234_567.5, currency: 'MNT' })).toBe('1,234,567.50 MNT');
    expect(renderText('{{amount}}', { amount: '12 000' })).toBe('12 000');
    expect(renderText('{{daysOverdue}}', { daysOverdue: 3 })).toBe('3');
    expect(renderText('{{daysOverdue}}', { daysOverdue: 0 })).toBe('0');
  });
  it('утга доторх {{…}} дахин задрахгүй', () => {
    expect(renderText('{{comment}}', { comment: '{{borrowerName}}', borrowerName: 'Болд' })).toBe('{{borrowerName}}');
  });
  it('trim хийнэ', () => expect(renderText('  {{comment}}  ', { comment: '' })).toBe(''));
});

describe('formatAmount', () => {
  it.each([[0, '0'], [999, '999'], [1000, '1,000'], [1_200_000, '1,200,000'], [1234.5, '1,234.50'], [1234.567, '1,234.57'], [-5000, '-5,000'], [Number.NaN, '']])('%s → %s', (n, s) => expect(formatAmount(n)).toBe(s));
});

describe('placeholder шалгалт', () => {
  it('extractPlaceholders давхардалгүй', () => expect(extractPlaceholders('{{a}} {{ b }} {{a}}')).toEqual(['a', 'b']));
  it('зөвшөөрөгдсөн бүгд хүчинтэй', () => {
    expect(findInvalidPlaceholders('{{borrowerName}} {{amount}} {{currency}} {{dueDate}} {{contractNo}} {{applicationNo}} {{daysOverdue}} {{comment}}')).toEqual([]);
  });
  it('үл мэдэгдэх нэр ба буруу хаалтыг олно', () => {
    expect(findInvalidPlaceholders('{{secret}} ба {{amount}}', 'гарчиг {{x}}')).toEqual(['secret', 'x']);
    expect(findInvalidPlaceholders('{{amount')).toEqual(['{{…}}']);
    expect(findInvalidPlaceholders('{{a b}}')).toEqual(['{{…}}']);
    expect(findInvalidPlaceholders(null, undefined, '')).toEqual([]);
  });
});

describe('имэйл html', () => {
  it('escapeHtml', () => expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'));
  it('textToHtml нь бүх зүйлийг escape хийнэ — скрипт ордоггүй', () => {
    const html = textToHtml('Сайн уу <script>alert(1)</script>\n\nНэмэлт "тайлбар"\nмөр 2');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html.match(/<p /g)).toHaveLength(2);
    expect(html).toContain('<br>');
  });
});

describe('smsSegments', () => {
  it('кирилл → UCS-2: 70 хүртэл 1 сегмент, дараа нь 67-оор', () => {
    expect(smsSegments('а'.repeat(70))).toEqual({ encoding: 'UCS2', length: 70, segments: 1 });
    expect(smsSegments('а'.repeat(71))).toMatchObject({ encoding: 'UCS2', segments: 2 });
    expect(smsSegments('а'.repeat(134))).toMatchObject({ segments: 2 });
    expect(smsSegments('а'.repeat(135))).toMatchObject({ segments: 3 });
  });
  it('латин → GSM-7: 160 / 153', () => {
    expect(smsSegments('a'.repeat(160))).toEqual({ encoding: 'GSM7', length: 160, segments: 1 });
    expect(smsSegments('a'.repeat(161))).toMatchObject({ segments: 2 });
  });
  it('хоосон → 0', () => expect(smsSegments('').segments).toBe(0));
});
