'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { NotificationBell, type NotificationBellItem } from '@los/ui';
import { t } from '../../lib/i18n';
import { notificationHref, toBellItem } from './notifications.utils';
import { notificationKeys, useMarkAllRead, useMarkRead, useNotificationList, useUnreadCount } from './useNotifications';

/** Хонхонд харуулах сүүлийн мэдэгдлийн тоо. */
export const BELL_PAGE_SIZE = 8;

/**
 * Shell-ийн толгойд залгах хонх (FR-13.2): уншаагүй тоог 30 секунд тутам асууж, нээгдэхэд сүүлийн мэдэгдлүүдийг татна.
 * Мэдэгдэл дарвал уншсан болгож, хүсэлттэй бол шийдвэрийн хуудас руу очно.
 */
export function NotificationBellContainer() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  const recent = useNotificationList({ page: 1, pageSize: BELL_PAGE_SIZE }, { enabled: open });
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();

  const unreadCount = unread.data?.unreadCount ?? 0;

  // Уншаагүй тоо өөрчлөгдвөл (шинэ мэдэгдэл ирсэн) нээлттэй жагсаалт хуучирсан гэсэн үг.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: notificationKeys.lists });
  }, [unreadCount, queryClient]);

  // Харьцангуй хугацааны суурь — жагсаалт шинэчлэгдэх бүрд л шинэчлэгдэнэ.
  const items = useMemo<NotificationBellItem[]>(() => {
    const nowMs = Date.now();
    return (recent.data?.items ?? []).map((n) => toBellItem(n, nowMs, t));
  }, [recent.data]);

  const onItemClick = (item: NotificationBellItem) => {
    const source = recent.data?.items.find((n) => n.id === item.id);
    if (!item.read) markRead.mutate(item.id);
    const href = source ? notificationHref(source) : null;
    if (href) router.push(href);
  };

  return (
    <NotificationBell
      items={items}
      unreadCount={unreadCount}
      loading={recent.isLoading}
      error={recent.isError}
      markingAll={markAll.isPending}
      onItemClick={onItemClick}
      onMarkAllRead={() => markAll.mutate()}
      onViewAll={() => router.push('/notifications')}
      onRetry={() => void recent.refetch()}
      onOpenChange={setOpen}
    />
  );
}
