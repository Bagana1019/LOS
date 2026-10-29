import { z } from 'zod';
import { DeliveryStatus, NotificationChannel, NotificationType, PushPlatform, RecipientType } from '../enums';

// FR-13.2: мэдэгдэл — хонх (in-app) + имэйл/SMS/push. Хүлээн авагч: ажилтан (USER) эсвэл зээлдэгч (CUSTOMER).
export const NotificationView = z.object({
  id: z.string(),
  type: z.enum(NotificationType),
  applicationId: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  payload: z.record(z.unknown()),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type NotificationView = z.infer<typeof NotificationView>;

// Query string-ийн "false" нь z.coerce.boolean()-д true болдог тул тусад нь задлана.
const queryBoolean = z.preprocess((v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : v), z.boolean());

export const NotificationListQuery = z.object({
  unreadOnly: queryBoolean.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type NotificationListQuery = z.infer<typeof NotificationListQuery>;

export const NotificationListResponse = z.object({
  items: z.array(NotificationView),
  total: z.number().int(),
  unreadCount: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type NotificationListResponse = z.infer<typeof NotificationListResponse>;

export const UnreadCountResponse = z.object({ unreadCount: z.number().int() });
export type UnreadCountResponse = z.infer<typeof UnreadCountResponse>;

export const MarkAllReadResponse = z.object({ updated: z.number().int() });
export type MarkAllReadResponse = z.infer<typeof MarkAllReadResponse>;

// Загварт ашиглаж болох placeholder-ууд ({{name}}). Үл мэдэгдэх нэр хадгалахад 400, харуулахад хоосон.
export const TEMPLATE_PLACEHOLDERS = ['borrowerName', 'amount', 'currency', 'dueDate', 'contractNo', 'applicationNo', 'daysOverdue', 'comment'] as const;
export type TemplatePlaceholder = (typeof TEMPLATE_PLACEHOLDERS)[number];

export const UpsertTemplateRequest = z.object({
  type: z.enum(NotificationType),
  channel: z.enum(NotificationChannel),
  locale: z.string().min(2).max(10).default('mn'),
  subject: z.string().max(200).nullish(), // EMAIL / IN_APP гарчиг
  body: z.string().min(1).max(2000), // {{placeholder}} — borrowerName, amount, dueDate, contractNo, applicationNo ...
  isActive: z.boolean().default(true),
});
export type UpsertTemplateRequest = z.infer<typeof UpsertTemplateRequest>;

export const TemplateView = z.object({
  id: z.string().nullable(), // null = кодонд суулгасан анхдагч загвар
  type: z.enum(NotificationType),
  channel: z.enum(NotificationChannel),
  locale: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  isActive: z.boolean(),
  isBuiltin: z.boolean(),
});
export type TemplateView = z.infer<typeof TemplateView>;

// Загварыг хадгалахгүйгээр жишээ утгаар render хийж харах (placeholder-ийн алдааг мөн хэлнэ).
export const PreviewTemplateRequest = z.object({
  type: z.enum(NotificationType),
  channel: z.enum(NotificationChannel),
  subject: z.string().max(200).nullish(),
  body: z.string().min(1).max(2000),
});
export type PreviewTemplateRequest = z.infer<typeof PreviewTemplateRequest>;

export const PreviewTemplateResponse = z.object({
  subject: z.string().nullable(),
  body: z.string(),
  html: z.string().nullable(), // зөвхөн EMAIL
  unknownPlaceholders: z.array(z.string()),
  smsSegments: z.number().int().nullable(), // зөвхөн SMS: UCS-2 сегментийн тоо
});
export type PreviewTemplateResponse = z.infer<typeof PreviewTemplateResponse>;

export const DeliveryView = z.object({
  id: z.string(),
  type: z.enum(NotificationType),
  channel: z.enum(NotificationChannel),
  recipientType: z.enum(RecipientType),
  recipientId: z.string(),
  addressMasked: z.string().nullable(),
  applicationId: z.string().nullable(),
  status: z.enum(DeliveryStatus),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  scheduledFor: z.string().datetime(),
  sentAt: z.string().datetime().nullable(),
});
export type DeliveryView = z.infer<typeof DeliveryView>;

export const DeliveryListQuery = z.object({
  applicationId: z.string().optional(),
  status: z.enum(DeliveryStatus).optional(),
  channel: z.enum(NotificationChannel).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type DeliveryListQuery = z.infer<typeof DeliveryListQuery>;

export const DeliveryListResponse = z.object({
  items: z.array(DeliveryView),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type DeliveryListResponse = z.infer<typeof DeliveryListResponse>;

export const RegisterPushDeviceRequest = z.object({
  ownerType: z.enum(RecipientType),
  ownerId: z.string().min(1),
  token: z.string().min(8).max(4096),
  platform: z.enum(PushPlatform),
});
export type RegisterPushDeviceRequest = z.infer<typeof RegisterPushDeviceRequest>;

export const PushDeviceView = z.object({
  id: z.string(),
  ownerType: z.enum(RecipientType),
  ownerId: z.string(),
  platform: z.enum(PushPlatform),
  tokenMasked: z.string(),
  isActive: z.boolean(),
  lastSeenAt: z.string().datetime(),
});
export type PushDeviceView = z.infer<typeof PushDeviceView>;

export const NotificationPreferenceRequest = z.object({
  channels: z.array(z.object({ channel: z.enum(NotificationChannel), enabled: z.boolean() })).min(1),
});
export type NotificationPreferenceRequest = z.infer<typeof NotificationPreferenceRequest>;

export const NotificationPreferenceView = z.object({
  recipientType: z.enum(RecipientType),
  recipientId: z.string(),
  channels: z.array(z.object({ channel: z.enum(NotificationChannel), enabled: z.boolean() })), // зөвхөн тухайн хүлээн авагчид хамаарах сувгууд
});
export type NotificationPreferenceView = z.infer<typeof NotificationPreferenceView>;

export const SendTestRequest = z.object({ channel: z.enum(NotificationChannel), to: z.string().min(3), type: z.enum(NotificationType).default('PAYMENT_DUE') });
export type SendTestRequest = z.infer<typeof SendTestRequest>;

export const RunRemindersRequest = z.object({ asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dryRun: z.boolean().default(false) });
export type RunRemindersRequest = z.infer<typeof RunRemindersRequest>;
export const RunRemindersResponse = z.object({ asOf: z.string(), scannedInstallments: z.number().int(), scheduledDeliveries: z.number().int(), skippedDuplicates: z.number().int(), dryRun: z.boolean() });
export type RunRemindersResponse = z.infer<typeof RunRemindersResponse>;
