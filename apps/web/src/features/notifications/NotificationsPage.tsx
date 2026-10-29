'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { App as AntApp, Badge, Button, Card, Flex, Pagination, Switch, Typography } from 'antd';
import type { NotificationView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { NotificationErrorAlert } from './NotificationErrorAlert';
import { NotificationList } from './NotificationList';
import { clampPage, describeError, notificationHref } from './notifications.utils';
import { useMarkAllRead, useMarkRead, useNotificationList } from './useNotifications';

const PAGE_SIZES = ['10', '20', '50', '100'];

/** `/notifications` — нэвтэрсэн ажилтны хонхны мэдэгдлийн бүрэн жагсаалт (шүүлт: уншаагүй, хуудаслалт). */
export function NotificationsPage() {
  const router = useRouter();
  const { message } = AntApp.useApp();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [busyId, setBusyId] = useState<string | null>(null);

  const list = useNotificationList({ unreadOnly, page, pageSize }, { keepPrevious: true });
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  const data = list.data;
  // Харьцангуй хугацааны суурь — жагсаалт шинэчлэгдэх бүрд л шинэчлэгдэнэ.
  const nowMs = useMemo(() => Date.now(), [data]);
  const unreadCount = data?.unreadCount ?? 0;

  // "Зөвхөн уншаагүй" шүүлтэд сүүлийн хуудсын мэдэгдлийг уншсаны дараа тэр хуудас хоосорно — ойролцоо хуудас руу буцна.
  useEffect(() => {
    if (!data || list.isPlaceholderData) return;
    const clamped = clampPage(page, data.total, data.pageSize);
    if (clamped !== page) setPage(clamped);
  }, [data, list.isPlaceholderData, page]);

  const fail = (error: unknown) => void message.error(describeError(error, t).message);

  const onMarkRead = (n: NotificationView) => {
    setBusyId(n.id);
    markRead.mutate(n.id, { onError: fail, onSettled: () => setBusyId(null) });
  };

  const onOpen = (n: NotificationView) => {
    if (n.readAt === null) markRead.mutate(n.id, { onError: fail });
    const href = notificationHref(n);
    if (href) router.push(href);
  };

  const onMarkAll = () =>
    markAll.mutate(undefined, {
      onSuccess: (res) => void message.success(t('notification.page.markAllReadDone', { count: res.updated })),
      onError: fail,
    });

  return (
    <main style={{ padding: 24, maxWidth: 960 }}>
      <Flex align="center" justify="space-between" wrap gap={12} style={{ marginBottom: 16 }}>
        <Flex align="center" gap={12}>
          <Typography.Title level={3} style={{ margin: 0 }}>{t('notification.page.title')}</Typography.Title>
          {unreadCount > 0 ? <Badge count={unreadCount} overflowCount={999} color="red" title={t('notification.page.unreadCount', { count: unreadCount })} /> : null}
        </Flex>
        <Flex align="center" gap={12} wrap>
          <Flex align="center" gap={8}>
            <Switch
              id="notification-unread-only"
              checked={unreadOnly}
              onChange={(checked) => {
                setUnreadOnly(checked);
                setPage(1);
              }}
            />
            <label htmlFor="notification-unread-only">{t('notification.page.unreadOnly')}</label>
          </Flex>
          <Button onClick={onMarkAll} disabled={unreadCount === 0} loading={markAll.isPending}>{t('notification.page.markAllRead')}</Button>
          <Button onClick={() => void list.refetch()} loading={list.isFetching && !list.isLoading}>{t('notification.common.refresh')}</Button>
        </Flex>
      </Flex>

      {list.isError && data ? <NotificationErrorAlert style={{ marginBottom: 12 }} error={list.error} onRetry={() => void list.refetch()} /> : null}

      <Card>
        <NotificationList
          items={data?.items ?? []}
          loading={list.isLoading}
          error={list.error}
          unreadOnly={unreadOnly}
          nowMs={nowMs}
          busyId={busyId}
          onOpen={onOpen}
          onMarkRead={onMarkRead}
          onRetry={() => void list.refetch()}
        />
        {data && data.total > 0 ? (
          <Flex justify="space-between" align="center" wrap gap={8} style={{ marginTop: 16 }}>
            <Typography.Text type="secondary">{t('notification.page.total', { total: data.total })}</Typography.Text>
            <Pagination
              current={page}
              pageSize={pageSize}
              total={data.total}
              pageSizeOptions={PAGE_SIZES}
              showSizeChanger
              onChange={(nextPage, nextSize) => {
                if (nextSize !== pageSize) {
                  setPageSize(nextSize);
                  setPage(1);
                } else {
                  setPage(nextPage);
                }
              }}
            />
          </Flex>
        ) : null}
      </Card>
    </main>
  );
}
