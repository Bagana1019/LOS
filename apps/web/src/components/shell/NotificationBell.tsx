'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Empty, List, Popover, Typography } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { NotificationFeed } from '@los/contracts';
import { t } from '@los/ui';
import { apiFetch } from '../../lib/api';
import { ApiError } from '../../lib/http';

const POLL_MS = 60_000;
const when = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('mn-MN', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
};
const isMissing = (e: unknown) => e instanceof ApiError && e.status === 404;

/** FR-13.2 хонх. Endpoint (`GET /origination/notifications`) M13-д хэрэгжинэ — тэр болтол 404 = "мэдэгдэл алга", дахин асуухгүй. */
export function NotificationBell() {
  const feed = useQuery({
    queryKey: ['notifications', 'feed'],
    queryFn: () => apiFetch('/origination/notifications?limit=10', { schema: NotificationFeed }),
    retry: false,
    refetchInterval: (q) => (isMissing(q.state.error) ? false : POLL_MS),
  });
  const unread = feed.data?.unreadCount ?? 0;
  const failed = feed.isError && !isMissing(feed.error);

  const content = (
    <div style={{ width: 320, maxWidth: 'calc(100vw - 48px)' }}>
      {failed ? (
        <Typography.Text type="danger">{t('shell.notifications.error')}</Typography.Text>
      ) : feed.data?.items.length ? (
        <List
          size="small"
          dataSource={feed.data.items}
          renderItem={(n) => (
            <List.Item>
              <List.Item.Meta
                title={<Typography.Text strong={!n.readAt}>{t(`shell.notifications.type.${n.type}`)}</Typography.Text>}
                description={when(n.createdAt)}
              />
            </List.Item>
          )}
        />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('shell.notifications.empty')} />
      )}
    </div>
  );

  return (
    <Popover content={content} title={t('shell.notifications')} trigger="click" placement="bottomRight">
      <Badge count={unread} size="small" overflowCount={99}>
        <Button type="text" shape="circle" icon={<BellOutlined aria-hidden style={{ fontSize: 18 }} />} aria-label={t('shell.notifications.aria', { n: unread })} />
      </Badge>
    </Popover>
  );
}
