import type { DeliveryView, NotificationChannel, NotificationType, NotificationView, RecipientType } from '@los/contracts';
import { DeliveryStatus } from '@los/contracts';
import type { NotificationDelivery, Notification } from '.prisma/client-origination';
import { maskAddress } from '../../integrations/channel/channel-error';
import type { RenderedMessage } from './template.service';

export function toNotificationView(row: Notification, rendered: RenderedMessage | null): NotificationView {
  const payload = (row.payloadJson && typeof row.payloadJson === 'object' && !Array.isArray(row.payloadJson) ? row.payloadJson : {}) as Record<string, unknown>;
  return {
    id: row.id, type: row.type as NotificationType, applicationId: row.applicationId,
    title: rendered?.subject ?? '', body: rendered?.body ?? '', payload,
    readAt: row.readAt ? row.readAt.toISOString() : null, createdAt: row.createdAt.toISOString(),
  };
}

export function toDeliveryView(row: NotificationDelivery): DeliveryView {
  return {
    id: row.id, type: row.type as NotificationType, channel: row.channel as NotificationChannel,
    recipientType: row.recipientType as RecipientType, recipientId: row.recipientId,
    addressMasked: maskAddress(row.channel, row.address), applicationId: row.applicationId,
    status: (DeliveryStatus as readonly string[]).includes(row.status) ? (row.status as DeliveryView['status']) : 'FAILED',
    attempts: row.attempts, lastError: row.lastError, scheduledFor: row.scheduledFor.toISOString(), sentAt: row.sentAt ? row.sentAt.toISOString() : null,
  };
}
