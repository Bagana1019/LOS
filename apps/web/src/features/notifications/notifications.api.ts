import type {
  DeliveryListResponse,
  DeliveryView,
  MarkAllReadResponse,
  NotificationListResponse,
  NotificationPreferenceRequest,
  NotificationPreferenceView,
  NotificationView,
  PreviewTemplateRequest,
  PreviewTemplateResponse,
  RecipientType,
  RunRemindersRequest,
  RunRemindersResponse,
  SendTestRequest,
  TemplateView,
  UnreadCountResponse,
  UpsertTemplateRequest,
} from '@los/contracts';
import { originationFetch, qs } from '../../lib/api';
import { buildDeliveryQuery, buildListQuery, type DeliveryFilter, type NotificationListParams } from './notifications.utils';

// Gateway-н замаар origination руу (`originationFetch` нь `/origination` угтварыг нэмнэ → `/api/origination/…`); origination-ий зам: `/notifications/…`.
const enc = encodeURIComponent;

// ── Ажилтны хонх (нэвтэрсэн ажилтан, зөвхөн өөрийн) ──────────────────────────────────
export const fetchNotifications = (params: NotificationListParams): Promise<NotificationListResponse> =>
  originationFetch<NotificationListResponse>(`/notifications${qs(buildListQuery(params))}`);

export const fetchUnreadCount = (): Promise<UnreadCountResponse> => originationFetch<UnreadCountResponse>('/notifications/unread-count');

/** Idempotent. Бусдын/байхгүй бол 404 NOTIFICATION_NOT_FOUND. */
export const markRead = (id: string): Promise<NotificationView> => originationFetch<NotificationView>(`/notifications/${enc(id)}/read`, { method: 'POST' });

export const markAllRead = (): Promise<MarkAllReadResponse> => originationFetch<MarkAllReadResponse>('/notifications/read-all', { method: 'POST' });

// ── Загвар (ADMIN) ───────────────────────────────────────────────────────────────────
/** Кодонд суулгасан 24 + override нийлсэн. */
export const fetchTemplates = (): Promise<TemplateView[]> => originationFetch<TemplateView[]>('/notifications/templates');

/** 400 INVALID_PLACEHOLDER | SUBJECT_REQUIRED. */
export const upsertTemplate = (body: UpsertTemplateRequest): Promise<TemplateView> => originationFetch<TemplateView>('/notifications/templates', { method: 'PUT', json: body });

/** Хадгалахгүйгээр жишээ утгаар render. */
export const previewTemplate = (body: PreviewTemplateRequest): Promise<PreviewTemplateResponse> =>
  originationFetch<PreviewTemplateResponse>('/notifications/templates/preview', { method: 'POST', json: body });

// ── Хүргэлтийн бүртгэл, туршилт, сануулга ────────────────────────────────────────────
/** ADMIN — бүгд; BRANCH_MANAGER — өөрийн салбарын хүсэлт (X-Branch-Id-гүй бол 403). */
export const fetchDeliveries = (filter: DeliveryFilter): Promise<DeliveryListResponse> =>
  originationFetch<DeliveryListResponse>(`/notifications/deliveries${qs(buildDeliveryQuery(filter))}`);

/** ADMIN. 422 INVALID_ADDRESS | CHANNEL_NOT_TESTABLE | TEMPLATE_NOT_FOUND. */
export const sendTest = (body: SendTestRequest): Promise<DeliveryView> => originationFetch<DeliveryView>('/notifications/test-send', { method: 'POST', json: body });

/** ADMIN. dryRun=true бол юу ч үүсгэхгүй, зөвхөн тоолно. */
export const runReminders = (body: Pick<RunRemindersRequest, 'dryRun'> & Partial<Pick<RunRemindersRequest, 'asOf'>>): Promise<RunRemindersResponse> =>
  originationFetch<RunRemindersResponse>('/notifications/reminders/run', { method: 'POST', json: body });

// ── Сувгийн opt-out ──────────────────────────────────────────────────────────────────
const prefPath = (recipientType: RecipientType, recipientId: string): string => `/notifications/preferences/${recipientType}/${enc(recipientId)}`;

export const fetchPreferences = (recipientType: RecipientType, recipientId: string): Promise<NotificationPreferenceView> =>
  originationFetch<NotificationPreferenceView>(prefPath(recipientType, recipientId));

/** 400 CHANNEL_NOT_APPLICABLE (зээлдэгчид IN_APP хамаарахгүй). */
export const putPreferences = (recipientType: RecipientType, recipientId: string, body: NotificationPreferenceRequest): Promise<NotificationPreferenceView> =>
  originationFetch<NotificationPreferenceView>(prefPath(recipientType, recipientId), { method: 'PUT', json: body });
