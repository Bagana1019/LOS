import { Module } from '@nestjs/common';
import { emailGatewayProvider } from '../../integrations/email/email.provider';
import { pushGatewayProvider } from '../../integrations/push/push.provider';
import { smsGatewayProvider } from '../../integrations/sms/sms.provider';
import { DeliveryAdminService } from './delivery-admin.service';
import { DeliveryProcessor } from './delivery.processor';
import { NotificationController } from './notification.controller';
import { NotificationEventConsumer } from './notification-event.consumer';
import { NOTIFICATION_QUEUE, createNotificationQueue } from './notification.queue';
import { NotificationRuntime } from './notification.runtime';
import { NotificationService } from './notification.service';
import { PreferenceService } from './preference.service';
import { PushDeviceService } from './push-device.service';
import { ReminderService } from './reminder.service';
import { TemplateService } from './template.service';

/**
 * Мэдэгдлийн систем (FR-13.2): ажилтны хонх (in-app) + зээлдэгчийн SMS / Email / Push, төлөлт сануулах.
 * Бусад модуль `NotificationService`-ийг (`notifyUsers`, `notifyCustomers`) дуудна. Шаардлага: CLAUDE.md §3.1 (BullMQ), §3.2.6/7, NFR-2/5.
 */
@Module({
  controllers: [NotificationController],
  providers: [
    smsGatewayProvider, emailGatewayProvider, pushGatewayProvider,
    { provide: NOTIFICATION_QUEUE, useFactory: () => createNotificationQueue() },
    TemplateService, NotificationService, DeliveryProcessor, DeliveryAdminService, ReminderService, PushDeviceService, PreferenceService,
    NotificationEventConsumer, NotificationRuntime,
  ],
  exports: [NotificationService, TemplateService],
})
export class NotificationModule {}
