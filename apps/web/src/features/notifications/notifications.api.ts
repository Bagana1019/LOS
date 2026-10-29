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
import { apiFetch, qs } from '../../lib/api';
import { buildDeliveryQuery, buildListQuery, type DeliveryFilter, type NotificationListParams } from './notifications.utils';

// Gateway-н замаар origination руу: `/notifications/…` (global prefix `api` нь API суурь URL-д орсон).
const enc = encodeURIComponent;

// ── Ажилтны хонх (нэвтэрсэн ажилтан, зөвхөн өөрийн) ──────────────────────────────────
export const fetchNotifications = (params: NotificationListParams): Promise<NotificationListResponse> =>
  apiFetch<NotificationListResponse>(`/notifications${qs(buildListQuery(params))}`);

export const fetchUnreadCount = (): Promise<UnreadCountResponse> => apiFetch<UnreadCountResponse>('/notifications/unread-count');

/** Idempotent. Бусдын/байхгүй бол 404 NOTIFICATION_NOT_FOUND. */
export const markRead = (id: string): Promise<NotificationView> => apiFetch<NotificationView>(`/notifications/${enc(id)}/read`, { method: 'POST' });

export const markAllRead = (): Promise<MarkAllReadResponse> => apiFetch<MarkAllReadResponse>('/notifications/read-all', { method: 'POST' });

// ── Загвар (ADMIN) ───────────────────────────────────────────────────────────────────
/** Кодонд суулгасан 24 + override нийлсэн. */
export const fetchTemplates = (): Promise<TemplateView[]> => apiFetch<TemplateView[]>('/notifications/templates');

/** 400 INVALID_PLACEHOLDER | SUBJECT_REQUIRED. */
export const upsertTemplate = (body: UpsertTemplateRequest): Promise<TemplateView> => apiFetch<TemplateView>('/notifications/templates', { method: 'PUT', json: body });

/** Хадгалахгүйгээр жишээ утгаар render. */
export const previewTemplate = (body: PreviewTemplateRequest): Promise<PreviewTemplateResponse> =>
  apiFetch<PreviewTemplateResponse>('/notifications/templates/preview', { method: 'POST', json: body });

// ── Хүргэлтийн бүртгэл, туршилт, сануулга ────────────────────────────────────────────
/** ADMIN — бүгд; BRANCH_MANAGER — өөрийн салбарын хүсэлт (X-Branch-Id-гүй бол 403). */
export const fetchDeliveries = (filter: DeliveryFilter): Promise<DeliveryListResponse> =>
  apiFetch<DeliveryListResponse>(`/notifications/deliveries${qs(buildDeliveryQuery(filter))}`);

/** ADMIN. 422 INVALID_ADDRESS | CHANNEL_NOT_TESTABLE | TEMPLATE_NOT_FOUND. */
export const sendTest = (body: SendTestRequest): Promise<DeliveryView> => apiFetch<DeliveryView>('/notifications/test-send', { method: 'POST', json: body });

/** ADMIN. dryRun=true бол юу ч үүсгэхгүй, зөвхөн тоолно. */
export const runReminders = (body: Pick<RunRemindersRequest, 'dryRun'> & Partial<Pick<RunRemindersRequest, 'asOf'>>): Promise<RunRemindersResponse> =>
  apiFetch<RunRemindersResponse>('/notifications/reminders/run', { method: 'POST', json: body });

// ── Сувгийн opt-out ──────────────────────────────────────────────────────────────────
const prefPath = (recipientType: RecipientType, recipientId: string): string => `/notifications/preferences/${recipientType}/${enc(recipientId)}`;

export const fetchPreferences = (recipientType: RecipientType, recipientId: string): Promise<NotificationPreferenceView> =>
  apiFetch<NotificationPreferenceView>(prefPath(recipientType, recipientId));

/** 400 CHANNEL_NOT_APPLICABLE (зээлдэгчид IN_APP хамаарахгүй). */
export const putPreferences = (recipientType: RecipientType, recipientId: string, body: NotificationPreferenceRequest): Promise<NotificationPreferenceView> =>
  apiFetch<NotificationPreferenceView>(prefPath(recipientType, recipientId), { method: 'PUT', json: body });
