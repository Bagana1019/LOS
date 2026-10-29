import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from './notifications.api';
import { retryTransient, shouldPoll, type NotificationListParams } from './notifications.utils';

// Query түлхүүр: ['notifications', 'list', params] · ['notifications', 'unread-count']. Мутаци бүрийн дараа `['notifications']`-г бүхэлд нь шинэчилнэ.
export const notificationKeys = {
  all: ['notifications'] as const,
  lists: ['notifications', 'list'] as const,
  list: (params: NotificationListParams) => ['notifications', 'list', params] as const,
  unread: ['notifications', 'unread-count'] as const,
};

/** Хонхны уншаагүй тоог асуух давтамж (brief: 30 секундийн polling). */
export const POLL_INTERVAL_MS = 30_000;

/** 401/403 (нэвтрээгүй, эрхгүй) бол асуухаа зогсооно. Хөтөч далд (background) табд байхад react-query өөрөө зогсооно. */
export function useUnreadCount() {
  return useQuery({
    queryKey: notificationKeys.unread,
    queryFn: api.fetchUnreadCount,
    refetchInterval: (query) => (shouldPoll(query.state.error) ? POLL_INTERVAL_MS : false),
    staleTime: POLL_INTERVAL_MS / 2,
    retry: retryTransient,
  });
}

interface ListOptions {
  /** false бол татахгүй (хонхны жагсаалтыг зөвхөн нээгдэхэд). */
  enabled?: boolean;
  /** Шүүлт/хуудас солиход өмнөх өгөгдлийг харуулсаар байх (хуудасны жагсаалт). */
  keepPrevious?: boolean;
}

export function useNotificationList(params: NotificationListParams, { enabled = true, keepPrevious = false }: ListOptions = {}) {
  return useQuery({
    queryKey: notificationKeys.list(params),
    queryFn: () => api.fetchNotifications(params),
    enabled,
    staleTime: 0,
    retry: retryTransient,
    placeholderData: keepPrevious ? keepPreviousData : undefined,
  });
}

/** Мутацийн дараа жагсаалт ба уншаагүй тоог шинэчилнэ; 404 (өөр газраас устсан) үед ч дахин татна. */
function useNotificationMutation<TVars, TData>(mutationFn: (vars: TVars) => Promise<TData>) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: notificationKeys.all });
  return useMutation({ mutationFn, onSuccess: refresh, onError: () => void refresh() });
}

export const useMarkRead = () => useNotificationMutation((id: string) => api.markRead(id));
export const useMarkAllRead = () => useNotificationMutation(() => api.markAllRead());
