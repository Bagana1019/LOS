import { z } from 'zod';
import { NotificationType } from './enums';

// FR-13.2, docs/03 `notification`. Хонхны жагсаалт: gateway `GET /api/origination/notifications` → NotificationFeed.
// Endpoint-ийг M13 хэрэгжүүлнэ; web хонх энэ хэлбэрийг л хүлээнэ (endpoint байхгүй 404 бол "мэдэгдэл алга" гэж харуулна).
export const NotificationItem = z.object({
  id: z.string(),
  type: z.enum(NotificationType),
  applicationId: z.string().nullable(),
  // docs/03 payload_json nullable → `{}`
  payload: z.record(z.unknown()).nullish().transform((v) => v ?? {}),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type NotificationItem = z.infer<typeof NotificationItem>;

export const NotificationFeed = z.object({
  items: z.array(NotificationItem),
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationFeed = z.infer<typeof NotificationFeed>;
