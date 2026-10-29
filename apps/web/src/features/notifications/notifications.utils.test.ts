import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DeliveryListQuery, NotificationChannel, NotificationListQuery, NotificationPreferenceRequest, NotificationType, PreviewTemplateRequest, RunRemindersRequest, SendTestRequest,
  TEMPLATE_PLACEHOLDERS, UpsertTemplateRequest,
} from '@los/contracts';
import type { DeliveryView, NotificationPreferenceView, NotificationView, RunRemindersResponse, TemplateView } from '@los/contracts';
import mnNotification from '../../../../../packages/ui/src/i18n/mn.notification.json';
import { ApiError, qs } from '../../lib/api';
import {
  CUSTOMER_CHANNELS, CUSTOMER_TYPES, DELIVERY_ERROR_KEYS, DELIVERY_STATUSES, ERROR_KEYS, NOTIFICATION_CHANNELS, NOTIFICATION_TYPES, PLACEHOLDERS, SMS_TARGET_LENGTH,
  buildDeliveryQuery, buildListQuery, buildPreviewRequest, buildRunRequest, buildTestRequest, buildUpsertRequest, channelKey, channelUsesSubject, clampPage, deliveryErrorLabel,
  describeError, draftFromView, extractPlaceholders, filterTemplates, findInvalidPlaceholders, formFromTemplate, formatDateTime, insertPlaceholder, isRetrying, isTemplateDirty,
  isValidIsoDate, normalizeEmail, normalizeMnPhone, notificationHref, placeholderKey, recipientTypeKey, relativeTime, reminderResultLines, retryTransient, shortId, shouldPoll,
  smsSegments, sourceKey, statusKey, templateRowKey, templateSource, templateTarget, testSendOutcome, toBellItem, toPreferenceRequest, truncate, typeKey, typesForChannel,
  validateRunForm, validateTemplateForm, validateTestAddress, type Translate,
} from './notifications.utils';

const dict = mnNotification as Record<string, string>;
/** lib/i18n.ts-ийн t()-тэй ижил: олдохгүй түлхүүрийг "!" угтвартай буцаана (тестэд илрүүлнэ). */
const tr: Translate = (key, params) => {
  const raw = dict[key] ?? `!${key}`;
  return params ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`)) : raw;
};

// ── fixtures ────────────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-28T09:10:21Z');

function notification(over: Partial<NotificationView> = {}): NotificationView {
  return { id: 'n1', type: 'RETURNED', applicationId: 'app-1', title: 'Хүсэлт буцаагдлаа', body: 'APP-1 буцаагдлаа', payload: {}, readAt: null, createdAt: '2026-10-28T09:05:00.000Z', ...over };
}

function delivery(over: Partial<DeliveryView> = {}): DeliveryView {
  return {
    id: 'd1', type: 'PAYMENT_DUE', channel: 'SMS', recipientType: 'CUSTOMER', recipientId: 'c1', addressMasked: '+976***33', applicationId: 'app-1', status: 'SENT', attempts: 1,
    lastError: null, scheduledFor: '2026-10-28T01:00:00.000Z', sentAt: '2026-10-28T01:00:05.000Z', ...over,
  };
}

function template(over: Partial<TemplateView> = {}): TemplateView {
  return { id: null, type: 'PAYMENT_DUE', channel: 'SMS', locale: 'mn', subject: null, body: '{{borrowerName}}, төлбөр {{dueDate}}.', isActive: true, isBuiltin: true, ...over };
}

describe('enum жагсаалтууд', () => {
  it('contracts-той нийцнэ', () => {
    expect(NOTIFICATION_TYPES).toEqual(NotificationType);
    expect(NOTIFICATION_CHANNELS).toEqual(NotificationChannel);
    expect(CUSTOMER_CHANNELS).toEqual(['SMS', 'EMAIL', 'PUSH']);
    expect(CUSTOMER_TYPES.every((x) => NotificationType.includes(x))).toBe(true);
    expect(PLACEHOLDERS).toEqual(TEMPLATE_PLACEHOLDERS);
  });
});

describe('огноо, хугацаа', () => {
  it('formatDateTime — Улаанбаатарын цаг (UTC+8)', () => {
    expect(formatDateTime('2026-10-28T09:10:21Z')).toBe('2026-10-28 17:10');
    expect(formatDateTime('2026-10-28T20:00:00.000Z')).toBe('2026-10-29 04:00'); // шөнө дундыг давна
    expect(formatDateTime('2026-12-31T16:30:00Z')).toBe('2027-01-01 00:30');
    expect(formatDateTime('энэ огноо биш')).toBe('энэ огноо биш');
  });

  it('relativeTime — минут, цаг, өдөр, долоо хоногоос хойш огноо', () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    expect(relativeTime(at(30_000), NOW, tr)).toBe('Дөнгөж сая');
    expect(relativeTime(at(-5 * 60_000), NOW, tr)).toBe('Дөнгөж сая'); // цагийн зөрүүгээс ирээдүйн огноо
    expect(relativeTime(at(60_000), NOW, tr)).toBe('1 минутын өмнө');
    expect(relativeTime(at(59 * 60_000), NOW, tr)).toBe('59 минутын өмнө');
    expect(relativeTime(at(60 * 60_000), NOW, tr)).toBe('1 цагийн өмнө');
    expect(relativeTime(at(23 * 3_600_000 + 59 * 60_000), NOW, tr)).toBe('23 цагийн өмнө');
    expect(relativeTime(at(24 * 3_600_000), NOW, tr)).toBe('1 өдрийн өмнө');
    expect(relativeTime(at(6 * 86_400_000), NOW, tr)).toBe('6 өдрийн өмнө');
    expect(relativeTime(at(7 * 86_400_000), NOW, tr)).toBe(formatDateTime(at(7 * 86_400_000)));
    expect(relativeTime('буруу', NOW, tr)).toBe('буруу');
  });

  it('isValidIsoDate — хуанлийн хүчинтэй өдөр', () => {
    for (const ok of ['2026-02-28', '2024-02-29', '2026-12-31']) expect(isValidIsoDate(ok), ok).toBe(true);
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '26-01-01', '2026-1-1', '2026/01/01', '', '2026-01-01T00:00']) expect(isValidIsoDate(bad), bad).toBe(false);
  });
});

describe('текст', () => {
  it('truncate — зай цэвэрлэж, урт бол … залгана', () => {
    expect(truncate('  а   б\nв  ', 10)).toBe('а б в');
    expect(truncate('абвгдеж', 5)).toBe('абвг…');
    expect(truncate('абвгд', 5)).toBe('абвгд');
    expect(truncate(null, 5)).toBe('');
  });
  it('shortId', () => {
    expect(shortId('0123456789abcdef')).toBe('01234567');
    expect(shortId('abc')).toBe('abc');
  });
});

describe('ажилтны хонх', () => {
  it('notificationHref — хүсэлттэй бол шийдвэрийн алхам, үгүй бол null', () => {
    expect(notificationHref({ applicationId: 'app-1' })).toBe('/los/loan-application/app-1/decision');
    expect(notificationHref({ applicationId: 'a/b c' })).toBe('/los/loan-application/a%2Fb%20c/decision');
    expect(notificationHref({ applicationId: null })).toBeNull();
  });

  it('toBellItem — уншсан эсэх, гарчиг хоосон бол төрлийн нэр', () => {
    const unread = toBellItem(notification(), NOW, tr);
    expect(unread).toEqual({ id: 'n1', title: 'Хүсэлт буцаагдлаа', body: 'APP-1 буцаагдлаа', timeLabel: '5 минутын өмнө', read: false });
    const read = toBellItem(notification({ readAt: '2026-10-28T09:06:00.000Z', title: '  ' }), NOW, tr);
    expect(read.read).toBe(true);
    expect(read.title).toBe('Буцаагдсан хүсэлт');
  });

  it('buildListQuery — зөвхөн уншаагүй үед л илгээнэ; сервер зөв задална', () => {
    expect(qs(buildListQuery({ page: 2, pageSize: 20 }))).toBe('?page=2&pageSize=20');
    expect(qs(buildListQuery({ unreadOnly: false, page: 1, pageSize: 10 }))).toBe('?page=1&pageSize=10');
    const withUnread = qs(buildListQuery({ unreadOnly: true, page: 1, pageSize: 8 }));
    expect(withUnread).toBe('?unreadOnly=true&page=1&pageSize=8');
    const parsed = NotificationListQuery.parse(Object.fromEntries(new URLSearchParams(withUnread)));
    expect(parsed).toEqual({ unreadOnly: true, page: 1, pageSize: 8 });
    expect(qs(buildListQuery({}))).toBe('');
  });

  it('clampPage — хуудас хоосорвол сүүлийн хуудас руу', () => {
    expect(clampPage(3, 41, 20)).toBe(3);
    expect(clampPage(4, 41, 20)).toBe(3);
    expect(clampPage(5, 0, 20)).toBe(1);
    expect(clampPage(0, 10, 20)).toBe(1);
    expect(clampPage(2, 20, 20)).toBe(1);
  });

  it('shouldPoll — 401/403 үед зогсоно', () => {
    expect(shouldPoll(null)).toBe(true);
    expect(shouldPoll(new ApiError(500, null, 'x'))).toBe(true);
    expect(shouldPoll(new ApiError(401, 'UNAUTHENTICATED', 'x'))).toBe(false);
    expect(shouldPoll(new ApiError(403, 'FORBIDDEN', 'x'))).toBe(false);
  });

  it('retryTransient — 4xx-ийг дахин оролдохгүй, сүлжээ/5xx-ийг нэг удаа', () => {
    expect(retryTransient(0, new ApiError(404, 'X', 'x'))).toBe(false);
    expect(retryTransient(0, new ApiError(403, 'FORBIDDEN', 'x'))).toBe(false);
    expect(retryTransient(0, new ApiError(500, null, 'x'))).toBe(true);
    expect(retryTransient(1, new ApiError(500, null, 'x'))).toBe(false);
    expect(retryTransient(0, new TypeError('Failed to fetch'))).toBe(true);
  });
});

describe('placeholder', () => {
  it('extractPlaceholders — зайтай хаалт, давхардал', () => {
    expect(extractPlaceholders('{{ amount }} ба {{amount}} {{dueDate}}')).toEqual(['amount', 'dueDate']);
    expect(extractPlaceholders('placeholder алга')).toEqual([]);
  });

  it('findInvalidPlaceholders — backend-тэй ижил дүрэм', () => {
    expect(findInvalidPlaceholders('{{borrowerName}} {{amount}} {{currency}} {{dueDate}} {{contractNo}} {{applicationNo}} {{daysOverdue}} {{comment}}')).toEqual([]);
    expect(findInvalidPlaceholders('{{foo}} {{amount}} {{bar}} {{foo}}')).toEqual(['foo', 'bar']);
    expect(findInvalidPlaceholders('{{ amount')).toEqual(['{{…}}']);
    expect(findInvalidPlaceholders('{{a b}}')).toEqual(['{{…}}']);
    expect(findInvalidPlaceholders('} ганц хаалт')).toEqual([]);
    expect(findInvalidPlaceholders(null, undefined, '{{x}}')).toEqual(['x']);
  });

  it('placeholder бүрт тайлбар (i18n) бий', () => {
    for (const p of PLACEHOLDERS) expect(dict[placeholderKey(p)], p).toBeTruthy();
  });

  it('insertPlaceholder — курсор, сонголт, хязгаар', () => {
    expect(insertPlaceholder('Сайн уу, ', 9, 9, 'borrowerName')).toEqual({ text: 'Сайн уу, {{borrowerName}}', caret: 25 });
    expect(insertPlaceholder('абвг', 2, 2, 'amount')).toEqual({ text: 'аб{{amount}}вг', caret: 12 });
    expect(insertPlaceholder('абвг', 1, 3, 'amount')).toEqual({ text: 'а{{amount}}г', caret: 11 }); // сонголтыг солино
    expect(insertPlaceholder('абвг', 3, 1, 'amount')).toEqual({ text: 'а{{amount}}г', caret: 11 }); // эсрэг сонголт
    expect(insertPlaceholder('абвг', 99, 99, 'amount').text).toBe('абвг{{amount}}');
    expect(insertPlaceholder('абвг', -5, -5, 'amount').text).toBe('{{amount}}абвг');
    expect(insertPlaceholder('абвг', Number.NaN, Number.NaN, 'amount').text).toBe('абвг{{amount}}');
    expect(insertPlaceholder('', 0, 0, 'comment')).toEqual({ text: '{{comment}}', caret: 11 });
  });
});

describe('SMS сегмент', () => {
  it('backend smsSegments-тай ижил', () => {
    expect(smsSegments('')).toEqual({ encoding: 'GSM7', length: 0, segments: 0 });
    expect(smsSegments('а'.repeat(70))).toMatchObject({ encoding: 'UCS2', segments: 1 });
    expect(smsSegments('а'.repeat(71))).toMatchObject({ segments: 2 });
    expect(smsSegments('а'.repeat(SMS_TARGET_LENGTH))).toMatchObject({ segments: 2 });
    expect(smsSegments('а'.repeat(SMS_TARGET_LENGTH + 1))).toMatchObject({ segments: 3 });
    expect(smsSegments('a'.repeat(160))).toMatchObject({ encoding: 'GSM7', segments: 1 });
    expect(smsSegments('a'.repeat(161))).toMatchObject({ segments: 2 });
  });
});

describe('загвар', () => {
  it('channelUsesSubject — SMS-д гарчиг байхгүй', () => {
    expect(channelUsesSubject('SMS')).toBe(false);
    for (const c of ['IN_APP', 'EMAIL', 'PUSH'] as const) expect(channelUsesSubject(c)).toBe(true);
  });

  it('templateSource — анхдагч / тусгай / идэвхгүй тусгай', () => {
    expect(templateSource({ id: null, isActive: true })).toBe('BUILTIN');
    expect(templateSource({ id: 't1', isActive: true })).toBe('OVERRIDE');
    expect(templateSource({ id: 't1', isActive: false })).toBe('OVERRIDE_INACTIVE');
  });

  it('formFromTemplate, templateTarget, templateRowKey', () => {
    const t1 = template({ channel: 'EMAIL', subject: 'Гарчиг', isActive: false });
    expect(formFromTemplate(t1)).toEqual({ subject: 'Гарчиг', body: t1.body, isActive: false });
    expect(formFromTemplate(template()).subject).toBe('');
    expect(templateTarget(t1)).toEqual({ type: 'PAYMENT_DUE', channel: 'EMAIL', locale: 'mn' });
    expect(templateRowKey(templateTarget(t1))).toBe('PAYMENT_DUE|EMAIL|mn');
  });

  it('isTemplateDirty', () => {
    const initial = { subject: 'a', body: 'b', isActive: true };
    expect(isTemplateDirty(initial, { ...initial })).toBe(false);
    expect(isTemplateDirty(initial, { ...initial, body: 'bb' })).toBe(true);
    expect(isTemplateDirty(initial, { ...initial, subject: '' })).toBe(true);
    expect(isTemplateDirty(initial, { ...initial, isActive: false })).toBe(true);
  });

  it('filterTemplates — төрөл, суваг', () => {
    const list = [template(), template({ channel: 'EMAIL', subject: 's' }), template({ type: 'APPROVED' }), template({ type: 'APPROVED', channel: 'IN_APP', subject: 's' })];
    expect(filterTemplates(list, {})).toHaveLength(4);
    expect(filterTemplates(list, { type: 'APPROVED' })).toHaveLength(2);
    expect(filterTemplates(list, { channel: 'EMAIL' })).toHaveLength(1);
    expect(filterTemplates(list, { type: 'APPROVED', channel: 'SMS' })).toHaveLength(1);
    expect(filterTemplates(list, { type: 'MENTION' })).toHaveLength(0);
  });

  it('typesForChannel — сувагт загвартай төрлүүд (дараалалтай), ачаалагдаагүй бол анхдагч', () => {
    const list = [template({ type: 'PAYMENT_OVERDUE' }), template({ type: 'APPROVED' }), template({ type: 'PAYMENT_DUE', channel: 'EMAIL', subject: 's' })];
    expect(typesForChannel(list, 'SMS')).toEqual(['APPROVED', 'PAYMENT_OVERDUE']);
    expect(typesForChannel(list, 'EMAIL')).toEqual(['PAYMENT_DUE']);
    expect(typesForChannel(undefined, 'PUSH')).toEqual([...CUSTOMER_TYPES]);
    expect(typesForChannel([], 'SMS')).toEqual([...CUSTOMER_TYPES]);
    expect(typesForChannel([], 'IN_APP')).toEqual([...NOTIFICATION_TYPES]);
  });

  describe('validateTemplateForm', () => {
    const ok = { subject: 'Гарчиг', body: '{{borrowerName}}, сайн уу', isActive: true };
    it('зөв утга', () => {
      expect(validateTemplateForm('EMAIL', ok)).toEqual([]);
      expect(validateTemplateForm('SMS', { ...ok, subject: '' })).toEqual([]); // SMS-д гарчиг шаардахгүй
    });
    it('агуулга хоосон / хэт урт', () => {
      expect(validateTemplateForm('SMS', { ...ok, body: '   ' }).map((e) => e.key)).toEqual(['notification.templates.error.bodyRequired']);
      const long = validateTemplateForm('SMS', { ...ok, body: 'а'.repeat(2001) });
      expect(long).toEqual([{ field: 'body', key: 'notification.templates.error.bodyTooLong', params: { max: 2000 } }]);
      expect(validateTemplateForm('SMS', { ...ok, body: 'а'.repeat(2000) })).toEqual([]);
    });
    it('гарчиг: EMAIL/PUSH/IN_APP-д заавал, дээд хязгаар 200', () => {
      for (const c of ['EMAIL', 'PUSH', 'IN_APP'] as const) {
        expect(validateTemplateForm(c, { ...ok, subject: ' ' }).map((e) => e.key), c).toEqual(['notification.templates.error.subjectRequired']);
      }
      expect(validateTemplateForm('EMAIL', { ...ok, subject: 'а'.repeat(201) })[0]).toMatchObject({ field: 'subject', key: 'notification.templates.error.subjectTooLong', params: { max: 200 } });
    });
    it('үл мэдэгдэх placeholder (агуулга ба гарчигт)', () => {
      expect(validateTemplateForm('SMS', { ...ok, body: 'Сайн уу {{name}}' })).toEqual([
        { field: 'body', key: 'notification.templates.error.unknownPlaceholders', params: { names: 'name' } },
      ]);
      expect(validateTemplateForm('EMAIL', { ...ok, subject: '{{foo}}', body: '{{bar}}' })[0].params).toEqual({ names: 'foo, bar' });
      // SMS-д гарчиг илгээгдэхгүй тул түүн доторх placeholder-ийг шалгахгүй
      expect(validateTemplateForm('SMS', { ...ok, subject: '{{foo}}' })).toEqual([]);
    });
    it('алдааны мессеж i18n-д бий', () => {
      const msgs = validateTemplateForm('EMAIL', { subject: '', body: '{{x}}', isActive: true }).map((e) => tr(e.key, e.params));
      expect(msgs.some((m) => m.startsWith('!'))).toBe(false);
      expect(msgs).toContain('Зөвшөөрөгдөөгүй placeholder: x');
    });
  });

  describe('buildUpsertRequest', () => {
    it('SMS — гарчиггүй; бусад — тайрсан гарчиг; DTO-д таарна', () => {
      const sms = buildUpsertRequest({ type: 'PAYMENT_DUE', channel: 'SMS', locale: 'mn' }, { subject: 'үл тоомсорлоно', body: '  Сайн уу  ', isActive: true });
      expect(sms).toEqual({ type: 'PAYMENT_DUE', channel: 'SMS', locale: 'mn', subject: null, body: 'Сайн уу', isActive: true });
      expect(UpsertTemplateRequest.parse(sms)).toEqual(sms);
      const email = buildUpsertRequest({ type: 'APPROVED', channel: 'EMAIL', locale: 'mn' }, { subject: '  Гарчиг ', body: 'Агуулга', isActive: false });
      expect(email).toMatchObject({ subject: 'Гарчиг', isActive: false });
      expect(UpsertTemplateRequest.parse(email)).toEqual(email);
    });
  });

  describe('buildPreviewRequest', () => {
    const target = { type: 'PAYMENT_DUE', channel: 'EMAIL' } as const;
    it('хүчинтэй хүсэлт DTO-д таарна', () => {
      const req = buildPreviewRequest(target, { subject: 'Гарчиг', body: 'Агуулга' });
      expect(req).toEqual({ type: 'PAYMENT_DUE', channel: 'EMAIL', subject: 'Гарчиг', body: 'Агуулга' });
      expect(PreviewTemplateRequest.parse(req)).toEqual(req);
    });
    it('SMS-д гарчиг null', () => {
      expect(buildPreviewRequest({ type: 'PAYMENT_DUE', channel: 'SMS' }, { subject: 'x', body: 'y' })?.subject).toBeNull();
    });
    it('хоосон / хэт урт бол null (сервер 400 өгөх тул илгээхгүй)', () => {
      expect(buildPreviewRequest(target, { subject: '', body: '  ' })).toBeNull();
      expect(buildPreviewRequest(target, { subject: '', body: 'а'.repeat(2001) })).toBeNull();
      expect(buildPreviewRequest(target, { subject: 'а'.repeat(201), body: 'x' })).toBeNull();
      expect(buildPreviewRequest(target, { subject: '', body: 'x' })).not.toBeNull(); // гарчиг хоосон ч урьдчилан харна
    });
  });
});

describe('хүргэлтийн бүртгэл', () => {
  it('buildDeliveryQuery — хоосон утгыг илгээхгүй; сервер зөв задална', () => {
    const q = buildDeliveryQuery({ status: 'FAILED', channel: 'SMS', applicationId: '  app-1 ', page: 2, pageSize: 50 });
    expect(q).toEqual({ status: 'FAILED', channel: 'SMS', applicationId: 'app-1', page: 2, pageSize: 50 });
    const parsed = DeliveryListQuery.parse(Object.fromEntries(new URLSearchParams(qs(q))));
    expect(parsed).toEqual({ status: 'FAILED', channel: 'SMS', applicationId: 'app-1', page: 2, pageSize: 50 });
    expect(qs(buildDeliveryQuery({ applicationId: '   ', page: 1, pageSize: 20 }))).toBe('?page=1&pageSize=20');
  });

  it('isRetrying', () => {
    expect(isRetrying({ status: 'QUEUED', attempts: 2 })).toBe(true);
    expect(isRetrying({ status: 'QUEUED', attempts: 0 })).toBe(false);
    expect(isRetrying({ status: 'FAILED', attempts: 5 })).toBe(false);
  });

  it('deliveryErrorLabel — мэдэгдэж буй код монголоор, үл мэдэгдэх нь эх хэлбэрээр', () => {
    expect(deliveryErrorLabel('INVALID_ADDRESS', tr)).toBe('Хүлээн авагчийн хаяг буруу');
    expect(deliveryErrorLabel('NOT_IMPLEMENTED', tr)).toBe('Интеграци хэрэгжээгүй');
    expect(deliveryErrorLabel('SOMETHING_NEW', tr)).toBe('SOMETHING_NEW');
    expect(deliveryErrorLabel(null, tr)).toBeNull();
    expect(deliveryErrorLabel('', tr)).toBeNull();
    for (const k of DELIVERY_ERROR_KEYS) expect(dict[k], k).toBeTruthy();
  });
});

describe('туршилтын мессеж', () => {
  it('normalizeMnPhone — backend phone.ts-тэй ижил', () => {
    for (const raw of ['99112233', '9911-2233', '+976 9911 2233', '976 99112233', '00976-99112233', '(99) 11.22.33']) expect(normalizeMnPhone(raw), raw).toBe('+97699112233');
    for (const bad of ['12345678', '4911223', '991122334', 'abc', '', null, undefined, '+97612345678']) expect(normalizeMnPhone(bad), String(bad)).toBeNull();
  });

  it('normalizeEmail', () => {
    expect(normalizeEmail(' bold@example.mn ')).toBe('bold@example.mn');
    for (const bad of ['bold', 'bold@', '@example.mn', 'bold@example', 'bo ld@example.mn', '', null]) expect(normalizeEmail(bad), String(bad)).toBeNull();
  });

  it('validateTestAddress — суваг бүрээр', () => {
    expect(validateTestAddress('SMS', '9911-2233')).toEqual({ ok: true, value: '+97699112233' });
    expect(validateTestAddress('SMS', '123')).toEqual({ ok: false, key: 'notification.test.error.invalidPhone' });
    expect(validateTestAddress('EMAIL', ' a@b.mn ')).toEqual({ ok: true, value: 'a@b.mn' });
    expect(validateTestAddress('EMAIL', 'a@b')).toEqual({ ok: false, key: 'notification.test.error.invalidEmail' });
    expect(validateTestAddress('PUSH', 'tok-12345')).toEqual({ ok: true, value: 'tok-12345' });
    expect(validateTestAddress('PUSH', 'short')).toEqual({ ok: false, key: 'notification.test.error.invalidToken' });
    for (const c of CUSTOMER_CHANNELS) expect(validateTestAddress(c, '   ')).toEqual({ ok: false, key: 'notification.test.error.required' });
  });

  it('buildTestRequest нь SendTestRequest-д таарна', () => {
    const req = buildTestRequest('SMS', '+97699112233', 'PAYMENT_OVERDUE');
    expect(SendTestRequest.parse(req)).toEqual(req);
  });

  it('testSendOutcome — төлөв бүрт зөв дүгнэлт', () => {
    expect(testSendOutcome(delivery(), tr)).toEqual({ level: 'success', message: 'Туршилтын мессеж илгээгдлээ (+976***33)' });
    expect(testSendOutcome(delivery({ status: 'FAILED', lastError: 'NOT_IMPLEMENTED' }), tr)).toEqual({ level: 'error', message: 'Илгээж чадсангүй: Интеграци хэрэгжээгүй' });
    expect(testSendOutcome(delivery({ status: 'SKIPPED', lastError: 'INVALID_TOKEN' }), tr)).toEqual({ level: 'warning', message: 'Алгассан: Push токен хүчингүй' });
    expect(testSendOutcome(delivery({ status: 'QUEUED', attempts: 1, lastError: 'TIMEOUT' }), tr)).toEqual({
      level: 'warning', message: 'Илгээж чадсангүй, дахин оролдлого хүлээгдэж байна: Үйлчилгээ хариу өгсөнгүй (оролдлого 1)',
    });
    expect(testSendOutcome(delivery({ status: 'QUEUED', attempts: 0 }), tr)).toEqual({ level: 'info', message: 'Мессеж дараалалд орлоо' });
    expect(testSendOutcome(delivery({ addressMasked: null }), tr).message).toBe('Туршилтын мессеж илгээгдлээ (—)');
  });
});

describe('төлөлтийн сануулга', () => {
  it('validateRunForm — хоосон эсвэл хүчинтэй огноо', () => {
    expect(validateRunForm({ asOf: '', dryRun: true })).toBeNull();
    expect(validateRunForm({ asOf: ' ', dryRun: true })).toBeNull();
    expect(validateRunForm({ asOf: '2026-11-28', dryRun: false })).toBeNull();
    expect(validateRunForm({ asOf: '2026-02-30', dryRun: true })).toBe('notification.reminders.error.invalidDate');
    expect(validateRunForm({ asOf: '28.11.2026', dryRun: true })).toBe('notification.reminders.error.invalidDate');
  });

  it('buildRunRequest — хоосон огноог илгээхгүй; RunRemindersRequest-д таарна', () => {
    expect(buildRunRequest({ asOf: '', dryRun: true })).toEqual({ dryRun: true });
    expect(buildRunRequest({ asOf: ' 2026-11-28 ', dryRun: false })).toEqual({ asOf: '2026-11-28', dryRun: false });
    for (const f of [{ asOf: '', dryRun: true }, { asOf: '2026-11-28', dryRun: false }]) {
      const req = buildRunRequest(f);
      expect(RunRemindersRequest.parse(req)).toEqual(req);
    }
  });

  it('reminderResultLines — dry-run ба бодит горимын шошго', () => {
    const base: RunRemindersResponse = { asOf: '2026-11-28', scannedInstallments: 12, scheduledDeliveries: 7, skippedDuplicates: 3, dryRun: true };
    const dry = reminderResultLines(base, tr);
    expect(dry.map((l) => l.key)).toEqual(['asOf', 'scanned', 'scheduled', 'duplicates']);
    expect(dry.map((l) => l.value)).toEqual(['2026-11-28', '12', '7', '3']);
    expect(dry[2].label).toBe('Үүсэх мэдэгдэл');
    expect(reminderResultLines({ ...base, dryRun: false }, tr)[2].label).toBe('Үүссэн мэдэгдэл');
    for (const l of dry) expect(l.label.startsWith('!')).toBe(false);
  });
});

describe('зээлдэгчийн сувгийн тохиргоо', () => {
  const view: NotificationPreferenceView = {
    recipientType: 'CUSTOMER', recipientId: 'c1',
    channels: [{ channel: 'SMS', enabled: true }, { channel: 'EMAIL', enabled: false }, { channel: 'PUSH', enabled: true }],
  };

  it('draftFromView', () => {
    expect(draftFromView(view)).toEqual({ SMS: true, EMAIL: false, PUSH: true });
  });

  it('toPreferenceRequest — зөвхөн өөрчлөгдсөн суваг; өөрчлөлтгүй бол null', () => {
    expect(toPreferenceRequest(view, draftFromView(view))).toBeNull();
    expect(toPreferenceRequest(view, {})).toBeNull();
    const req = toPreferenceRequest(view, { ...draftFromView(view), SMS: false, EMAIL: true });
    expect(req).toEqual({ channels: [{ channel: 'SMS', enabled: false }, { channel: 'EMAIL', enabled: true }] });
    expect(NotificationPreferenceRequest.parse(req)).toEqual(req);
    // өөрчлөөд буцаагаад анхны утга руу оруулбал өөрчлөлт алга
    expect(toPreferenceRequest(view, { ...draftFromView(view), SMS: false })).not.toBeNull();
    expect(toPreferenceRequest(view, { ...draftFromView(view), SMS: true })).toBeNull();
    // харилцагчид хамаарахгүй суваг (IN_APP) draft-д орсон ч хүсэлтэд орохгүй
    expect(toPreferenceRequest(view, { ...draftFromView(view), IN_APP: false })).toBeNull();
  });
});

describe('describeError', () => {
  it('мэдэгдэж буй кодыг монголоор', () => {
    expect(describeError(new ApiError(403, 'FORBIDDEN', 'Энэ үйлдэлд эрх хүрэхгүй'), tr)).toEqual({ code: 'FORBIDDEN', message: 'Энэ үйлдэлд эрх хүрэхгүй', issues: [] });
    expect(describeError(new ApiError(404, 'NOTIFICATION_NOT_FOUND', 'x'), tr).message).toBe('Мэдэгдэл олдсонгүй');
    expect(describeError(new ApiError(422, 'INVALID_ADDRESS', 'x'), tr).message).toBe('Хүлээн авагчийн хаяг буруу байна');
    expect(describeError(new ApiError(422, 'CHANNEL_NOT_TESTABLE', 'x'), tr).message).toBe('Хонхны мэдэгдлийг туршилтаар илгээх боломжгүй');
    expect(describeError(new ApiError(422, 'TEMPLATE_NOT_FOUND', 'x'), tr).message).toBe('Энэ төрөл, сувгийн загвар байхгүй байна');
    expect(describeError(new ApiError(400, 'SUBJECT_REQUIRED', 'x'), tr).message).toBe('Энэ сувгийн загварт гарчиг заавал байх ёстой');
    expect(describeError(new ApiError(404, 'CUSTOMER_NOT_FOUND', 'x'), tr).message).toBe('Харилцагч олдсонгүй');
    expect(describeError(new ApiError(404, 'PUSH_DEVICE_NOT_FOUND', 'x'), tr).message).toBe('Төхөөрөмж олдсонгүй');
  });

  it('INVALID_PLACEHOLDER, CHANNEL_NOT_APPLICABLE — нэр бүхий серверийн мессеж', () => {
    const msg = 'Загварт зөвшөөрөгдөөгүй placeholder байна: foo, bar';
    expect(describeError(new ApiError(400, 'INVALID_PLACEHOLDER', msg), tr).message).toBe(msg);
    expect(describeError(new ApiError(400, 'INVALID_PLACEHOLDER', ''), tr).message).toBe('Загварт зөвшөөрөгдөөгүй placeholder байна'); // мессеж хоосон бол i18n
    expect(describeError(new ApiError(400, 'CHANNEL_NOT_APPLICABLE', 'Энэ хүлээн авагчид IN_APP суваг хамаарахгүй'), tr).message).toBe('Энэ хүлээн авагчид IN_APP суваг хамаарахгүй');
  });

  it('VALIDATION_FAILED — талбарын жагсаалттай', () => {
    const e = new ApiError(400, 'VALIDATION_FAILED', 'Оролтын өгөгдөл буруу', [{ path: 'to', message: 'Required' }, { path: '', message: 'Буруу' }, { path: 'x', message: '' }]);
    expect(describeError(e, tr)).toEqual({ code: 'VALIDATION_FAILED', message: 'Оролтын өгөгдөл буруу байна', issues: ['to: Required', 'Буруу'] });
  });

  it('код байхгүй үед статус, сүлжээ', () => {
    expect(describeError(new ApiError(401, null, 'x'), tr).message).toBe('Нэвтрээгүй байна. Дахин нэвтэрнэ үү');
    expect(describeError(new ApiError(403, null, 'x'), tr).message).toBe('Энэ үйлдэлд эрх хүрэхгүй');
    expect(describeError(new ApiError(502, null, 'x'), tr).message).toBe('Серверийн алдаа гарлаа. Түр хүлээгээд дахин оролдоно уу');
    expect(describeError(new TypeError('Failed to fetch'), tr).message).toBe('Сервертэй холбогдож чадсангүй. Сүлжээгээ шалгана уу');
    expect(describeError(new ApiError(418, 'TEAPOT', 'Хувин шиг'), tr).message).toBe('Хувин шиг');
    expect(describeError(null, tr).message).toBe('Тодорхойгүй алдаа гарлаа');
    expect(describeError('?', tr).code).toBeNull();
  });

  it('алдааны түлхүүр бүр i18n-д бий', () => {
    for (const k of ERROR_KEYS) expect(dict[k], k).toBeTruthy();
  });
});

describe('i18n бүрэн байдал', () => {
  it('enum бүрт шошго бий', () => {
    for (const x of NOTIFICATION_TYPES) expect(dict[typeKey(x)], x).toBeTruthy();
    for (const x of NOTIFICATION_CHANNELS) expect(dict[channelKey(x)], x).toBeTruthy();
    for (const x of DELIVERY_STATUSES) expect(dict[statusKey(x)], x).toBeTruthy();
    for (const x of ['USER', 'CUSTOMER'] as const) expect(dict[recipientTypeKey(x)], x).toBeTruthy();
    for (const x of ['BUILTIN', 'OVERRIDE', 'OVERRIDE_INACTIVE'] as const) expect(dict[sourceKey(x)], x).toBeTruthy();
  });

  it('кодод ашигласан бүх түлхүүр JSON-д бий, JSON-ийн бүх түлхүүр хэрэглэгдсэн', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const bell = fileURLToPath(new URL('../../../../../packages/ui/src/notification/NotificationBell.tsx', import.meta.url));
    const sources = [
      ...readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts')).map((f) => readFileSync(`${dir}${f}`, 'utf8')),
      readFileSync(bell, 'utf8'),
    ];
    const literal = new Set<string>();
    const prefixes = new Set<string>();
    for (const src of sources) {
      for (const m of src.matchAll(/['"`](notification\.[A-Za-z0-9_.]+)['"`]/g)) literal.add(m[1]);
      for (const m of src.matchAll(/`(notification\.[A-Za-z0-9_.]*)\$\{/g)) prefixes.add(m[1]);
    }
    expect([...literal].filter((k) => !(k in dict)), 'JSON-д байхгүй түлхүүр').toEqual([]);
    // динамик түлхүүр (`notification.type.${…}`) бүрт ядаж нэг түлхүүр бий
    for (const p of prefixes) expect(Object.keys(dict).some((k) => k.startsWith(p)), `${p}…`).toBe(true);
    const unused = Object.keys(dict).filter((k) => !literal.has(k) && ![...prefixes].some((p) => k.startsWith(p)));
    expect(unused, 'хэрэглэгдээгүй түлхүүр').toEqual([]);
  });

  it('суваг тус бүрийн динамик түлхүүр (test.toPlaceholder, preferences.desc) бүрэн', () => {
    for (const c of CUSTOMER_CHANNELS) {
      expect(dict[`notification.test.toPlaceholder.${c}`], c).toBeTruthy();
      expect(dict[`notification.preferences.desc.${c}`], c).toBeTruthy();
    }
  });

  it('{param} бүхий мессежүүд хаалтаа зөв хаасан, түлхүүр бүр хоосон биш', () => {
    for (const [k, v] of Object.entries(dict)) {
      expect(v.trim().length, k).toBeGreaterThan(0);
      expect((v.match(/\{/g) ?? []).length, k).toBe((v.match(/\}/g) ?? []).length);
    }
  });

  it('бүх түлхүүр `notification.` угтвартай', () => {
    expect(Object.keys(dict).filter((k) => !k.startsWith('notification.'))).toEqual([]);
  });
});
