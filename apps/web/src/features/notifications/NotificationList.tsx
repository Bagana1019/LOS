'use client';
import { Badge, Button, Empty, Flex, List, Skeleton, Tag, Tooltip, Typography } from 'antd';
import type { NotificationView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { NotificationErrorAlert } from './NotificationErrorAlert';
import { CHANNEL_COLOR, formatDateTime, notificationHref, relativeTime, typeKey } from './notifications.utils';

interface Props {
  items: readonly NotificationView[];
  /** Анхны ачаалалт (өгөгдөл байхгүй). */
  loading: boolean;
  error: unknown;
  unreadOnly: boolean;
  /** Харьцангуй хугацааны суурь (өгөгдөл татсан мөч). */
  nowMs: number;
  /** Уншсан болгож байгаа мэдэгдлийн id. */
  busyId: string | null;
  /** Мэдэгдэл нээх: уншаагүй бол уншсан болгож, хүсэлттэй бол шийдвэрийн хуудас руу очно. */
  onOpen: (n: NotificationView) => void;
  onMarkRead: (n: NotificationView) => void;
  onRetry: () => void;
}

export function NotificationList({ items, loading, error, unreadOnly, nowMs, busyId, onOpen, onMarkRead, onRetry }: Props) {
  if (error && items.length === 0) return <NotificationErrorAlert error={error} title={t('notification.page.loadError')} onRetry={onRetry} />;
  if (loading && items.length === 0) return <Skeleton active paragraph={{ rows: 6 }} />;
  if (items.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(unreadOnly ? 'notification.page.emptyUnread' : 'notification.page.empty')} />;
  }

  return (
    <List
      itemLayout="horizontal"
      dataSource={[...items]}
      renderItem={(n) => {
        const unread = n.readAt === null;
        const href = notificationHref(n);
        return (
          <List.Item
            key={n.id}
            actions={[
              unread ? (
                <Button key="read" type="link" size="small" loading={busyId === n.id} onClick={() => onMarkRead(n)}>{t('notification.page.markRead')}</Button>
              ) : null,
              href ? <Button key="open" type="link" size="small" onClick={() => onOpen(n)}>{t('notification.page.open')}</Button> : null,
            ].filter((a) => a !== null)}
          >
            <List.Item.Meta
              avatar={<Badge status={unread ? 'processing' : 'default'} />}
              title={
                <Flex gap={8} align="center" wrap>
                  {unread ? <Tag color="red">{t('notification.page.unread')}</Tag> : null}
                  <Tag color={CHANNEL_COLOR.IN_APP}>{t(typeKey(n.type))}</Tag>
                  <Button type="link" style={{ padding: 0, height: 'auto', fontWeight: unread ? 600 : 400 }} onClick={() => onOpen(n)}>
                    {n.title || t(typeKey(n.type))}
                  </Button>
                </Flex>
              }
              description={
                <Flex vertical gap={2}>
                  <Typography.Text style={{ whiteSpace: 'pre-line' }}>{n.body}</Typography.Text>
                  <Tooltip title={formatDateTime(n.createdAt)}>
                    <Typography.Text type="secondary">{relativeTime(n.createdAt, nowMs, t)}</Typography.Text>
                  </Tooltip>
                </Flex>
              }
            />
          </List.Item>
        );
      }}
    />
  );
}
