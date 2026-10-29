import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mn } from '@los/ui';
import VerifyRoute, { metadata as verifyMetadata } from '../../app/verify/[code]/page';
import SignPage, { metadata as signMetadata } from '../../app/sign/[token]/page';
import { visibleText } from './testing/html';
import { CODE, TOKEN } from './testing/fixtures';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/sign/[token] хуудас', () => {
  it('metadata: noindex, referrer no-referrer, гарчиг статик (токенгүй)', () => {
    expect(signMetadata.robots).toMatchObject({ index: false, follow: false, noarchive: true, nocache: true });
    expect(signMetadata.referrer).toBe('no-referrer');
    expect(signMetadata.title).toBe(mn['esign.page.title']);
    expect(JSON.stringify(signMetadata)).not.toContain(TOKEN);
  });

  it('Next 15: params нь Promise — токеныг await хийж SigningFlow-д өгнө', async () => {
    const element = await SignPage({ params: Promise.resolve({ token: TOKEN }) });
    expect(element.props).toEqual({ token: TOKEN });
  });

  it('SSR: токен хэлбэрийн хувьд зөв бол ачаалж байна (сервер талд fetch хийхгүй)', async () => {
    const html = renderToString(await SignPage({ params: Promise.resolve({ token: TOKEN }) }));
    expect(visibleText(html)).toContain('Ачаалж байна…');
    expect(html).not.toContain(TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SSR: хэлбэр буруу токен → "Холбоос олдсонгүй", сүлжээнд хүсэлт гарахгүй', async () => {
    const html = renderToString(await SignPage({ params: Promise.resolve({ token: '../../etc/passwd' }) }));
    expect(visibleText(html)).toContain('Холбоос олдсонгүй');
    expect(html).not.toContain('etc/passwd');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/verify/[code] хуудас', () => {
  it('metadata: noindex, no-referrer', () => {
    expect(verifyMetadata.robots).toMatchObject({ index: false, follow: false });
    expect(verifyMetadata.referrer).toBe('no-referrer');
    expect(verifyMetadata.title).toBe(mn['verify.page.title']);
  });

  it('SSR: зөв кодын хувьд "Шалгаж байна…"', async () => {
    const html = renderToString(await VerifyRoute({ params: Promise.resolve({ code: CODE }) }));
    expect(visibleText(html)).toContain('Шалгаж байна…');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('SSR: буруу код → "Баталгаажуулах код олдсонгүй", хүсэлт гарахгүй', async () => {
    const html = renderToString(await VerifyRoute({ params: Promise.resolve({ code: 'OOOO-0000-IIII' }) }));
    expect(visibleText(html)).toContain('Баталгаажуулах код олдсонгүй');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
