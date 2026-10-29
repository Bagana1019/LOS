import { describe, expect, it } from 'vitest';
import { NotificationType, TEMPLATE_PLACEHOLDERS } from '@los/contracts';
import { builtinTemplate, builtinTemplates, CUSTOMER_TYPES } from './template.builtin';
import { SAMPLE_VARS } from './template.service';
import { findInvalidPlaceholders, renderText, smsSegments } from './template.render';

// Хамгийн урт бодит утгууд — SMS 2 сегмент (≤ 134 тэмдэгт)-д багтах ёстой.
const WORST = { borrowerName: 'Бат-Эрдэнэ', amount: 120_000_000, currency: 'MNT', dueDate: '2026-10-28', contractNo: 'BZ-2026-000123', applicationNo: 'APP-2026-000123', daysOverdue: 120, comment: '' };

describe('кодонд суулгасан загварууд', () => {
  it('9 төрөл бүрт IN_APP загвар байна (хонх)', () => {
    for (const type of NotificationType) {
      const t = builtinTemplate(type, 'IN_APP', 'mn');
      expect(t, type).not.toBeNull();
      expect(t!.subject, `${type} гарчиг`).toBeTruthy();
    }
  });

  it('зээлдэгчид чиглэсэн 5 төрөл бүрт SMS + EMAIL + PUSH', () => {
    expect([...CUSTOMER_TYPES]).toEqual(['APPROVED', 'DISBURSEMENT_APPROVED', 'PAYMENT_DUE', 'PAYMENT_OVERDUE', 'PAYMENT_RECEIVED']);
    for (const type of CUSTOMER_TYPES) for (const ch of ['SMS', 'EMAIL', 'PUSH'] as const) expect(builtinTemplate(type, ch, 'mn'), `${type}/${ch}`).not.toBeNull();
  });

  it('ажилтан-only төрөлд SMS/EMAIL/PUSH байхгүй; mn-ээс өөр locale байхгүй', () => {
    expect(builtinTemplate('SLA_BREACH', 'SMS', 'mn')).toBeNull();
    expect(builtinTemplate('MENTION', 'EMAIL', 'mn')).toBeNull();
    expect(builtinTemplate('APPROVED', 'SMS', 'en')).toBeNull();
  });

  it('нийт 9 + 15 = 24 загвар, type×channel давхардалгүй', () => {
    const all = builtinTemplates();
    expect(all).toHaveLength(24);
    expect(new Set(all.map((t) => `${t.type}|${t.channel}`)).size).toBe(24);
  });

  it('зөвхөн зөвшөөрөгдсөн placeholder ашигласан; EMAIL/PUSH/IN_APP-д гарчигтай, SMS-д гарчиггүй', () => {
    for (const t of builtinTemplates()) {
      expect(findInvalidPlaceholders(t.subject, t.body), `${t.type}/${t.channel}`).toEqual([]);
      if (t.channel === 'SMS') expect(t.subject).toBeNull(); else expect(t.subject, `${t.type}/${t.channel}`).toBeTruthy();
    }
    expect(TEMPLATE_PLACEHOLDERS).toHaveLength(8);
  });

  it('SMS нь хамгийн урт утгатай ч ≤ 2 сегмент (≤ 134 тэмдэгт)', () => {
    for (const type of CUSTOMER_TYPES) {
      const text = renderText(builtinTemplate(type, 'SMS', 'mn')!.body, WORST);
      const seg = smsSegments(text);
      expect(seg.encoding).toBe('UCS2');
      expect(seg.length, `${type}: ${text}`).toBeLessThanOrEqual(134);
      expect(seg.segments).toBeLessThanOrEqual(2);
    }
  });

  it('жишээ утгаар render хийхэд placeholder үлдэхгүй, хоосон биш', () => {
    for (const t of builtinTemplates()) {
      const body = renderText(t.body, SAMPLE_VARS);
      expect(body, `${t.type}/${t.channel}`).not.toMatch(/\{\{|\}\}/);
      expect(body.length).toBeGreaterThan(10);
    }
  });
});
