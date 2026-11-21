import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NotificationView } from '@los/contracts';
import { NotificationList } from './NotificationList';

// F3-5: мэдэгдлийн жагсаалтад дүн ₮-өөр харагдана.

const item = (body: string): NotificationView => ({
  id: 'n-1', type: 'DISBURSEMENT_APPROVED', applicationId: 'a-1', title: 'Олголт зөвшөөрөгдлөө', body, payload: {}, readAt: null, createdAt: '2026-11-20T03:00:00.000Z',
});

const render = (body: string) => renderToStaticMarkup(
  <NotificationList items={[item(body)]} loading={false} error={null} unreadOnly={false} nowMs={Date.parse('2026-11-20T04:00:00.000Z')} busyId={null} onOpen={() => undefined} onMarkRead={() => undefined} onRetry={() => undefined} />,
);

describe('NotificationList body text (F3-5)', () => {
  it('shows the amount with ₮ instead of the MNT code', () => {
    const html = render('APP-2026-000123 дугаартай хүсэлтийн 20,000,000 MNT олголт зөвшөөрөгдлөө.');
    expect(html).toContain('20,000,000₮ олголт зөвшөөрөгдлөө');
    expect(html).not.toContain('MNT');
  });

  it('keeps a body without amounts exactly as the server wrote it', () => {
    expect(render('APP-2026-000123 дугаартай хүсэлт батлагдлаа.')).toContain('APP-2026-000123 дугаартай хүсэлт батлагдлаа.');
  });
});
