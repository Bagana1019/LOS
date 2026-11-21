import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api';
import { hasMessage, t } from '../../lib/i18n';
import { isForbiddenError } from './applications.utils';
import { ListLoadError } from './ListLoadError';

// F12-4: жагсаалтын 403 → "эрх байхгүй", давтан оролдох товчгүй; бусад алдаа → "ачаалж чадсангүй" + "Дахин оролдох" (хуучнаар).
const api = (status: number) => new ApiError(status, null, 'x');
const render = (error: unknown, errorKey = 'application.list.error', forbiddenKey = 'application.list.forbidden') =>
  renderToStaticMarkup(<ListLoadError error={error} errorKey={errorKey} forbiddenKey={forbiddenKey} onRetry={() => undefined} />);

describe('isForbiddenError', () => {
  it('зөвхөн HTTP 403', () => {
    expect(isForbiddenError(api(403))).toBe(true);
    for (const s of [0, 401, 404, 422, 500, 503]) expect(isForbiddenError(api(s)), String(s)).toBe(false);
  });
  it('ApiError биш утга (сүлжээний TypeError, null, string) → false', () => {
    expect(isForbiddenError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isForbiddenError(null)).toBe(false);
    expect(isForbiddenError(undefined)).toBe(false);
    expect(isForbiddenError('403')).toBe(false);
  });
});

describe('i18n түлхүүрүүд', () => {
  it('хүсэлт, зээлийн "эрх байхгүй" мессеж байна, хуучин алдааны мессеж өөрчлөгдөөгүй', () => {
    expect(t('application.list.forbidden')).toBe('Танд хүсэлтийн жагсаалтыг харах эрх байхгүй');
    expect(t('loan.list.forbidden')).toBe('Танд зээлийн жагсаалтыг харах эрх байхгүй');
    expect(hasMessage('application.list.error')).toBe(true);
    expect(t('application.list.error')).toBe('Хүсэлтийн жагсаалтыг ачаалж чадсангүй');
    expect(t('loan.list.error')).toBe('Зээлийн жагсаалтыг ачаалж чадсангүй');
  });
});

describe('ListLoadError', () => {
  it('403: "эрх байхгүй" мессеж, "Дахин оролдох" товч байхгүй', () => {
    const html = render(api(403));
    expect(html).toContain(t('application.list.forbidden'));
    expect(html).not.toContain(t('application.list.retry'));
    expect(html).not.toContain(t('application.list.error'));
    expect(html).not.toContain('<button');
  });
  it('403 зээлийн жагсаалтын түлхүүрээр', () => {
    const html = render(api(403), 'loan.list.error', 'loan.list.forbidden');
    expect(html).toContain(t('loan.list.forbidden'));
    expect(html).not.toContain('<button');
  });
  it.each([0, 401, 404, 500, 503])('%i: хуучин мессеж + "Дахин оролдох" товч', (status) => {
    const html = render(api(status));
    expect(html).toContain(t('application.list.error'));
    expect(html).toContain(t('application.list.retry'));
    expect(html).not.toContain(t('application.list.forbidden'));
  });
  it('сүлжээний алдаа (TypeError): хуучин мессеж + "Дахин оролдох" товч', () => {
    const html = render(new TypeError('Failed to fetch'), 'loan.list.error', 'loan.list.forbidden');
    expect(html).toContain(t('loan.list.error'));
    expect(html).toContain(t('application.list.retry'));
  });
});
