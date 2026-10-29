'use client';
import { Flex, Tabs, Typography } from 'antd';
import { t } from '../../lib/i18n';
import { CustomerPreferencesPanel } from './CustomerPreferences';
import { DeliveriesPanel } from './DeliveriesPanel';
import { RemindersCard } from './RemindersCard';
import { TemplatesPanel } from './TemplatesPanel';
import { TestSendCard } from './TestSendCard';

/**
 * `/settings/notifications` — мэдэгдлийн тохиргоо (ADMIN): загвар, хүргэлтийн бүртгэл, туршилт ба сануулга, зээлдэгчийн суваг.
 * Табын агуулга идэвхжих үед л ачаалагдана. Эрх хүрэхгүй табад (жишээ: BRANCH_MANAGER-д загвар) сервер 403 өгч, алдаа харагдана.
 */
export function NotificationSettingsPage() {
  return (
    <div>
      <Flex vertical gap={4} style={{ marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>{t('notification.settings.title')}</Typography.Title>
        <Typography.Text type="secondary">{t('notification.settings.subtitle')}</Typography.Text>
      </Flex>
      <Tabs
        defaultActiveKey="templates"
        items={[
          { key: 'templates', label: t('notification.settings.tab.templates'), children: <TemplatesPanel /> },
          { key: 'deliveries', label: t('notification.settings.tab.deliveries'), children: <DeliveriesPanel /> },
          {
            key: 'tools',
            label: t('notification.settings.tab.tools'),
            children: (
              <Flex vertical gap={16}>
                <TestSendCard />
                <RemindersCard />
              </Flex>
            ),
          },
          { key: 'customers', label: t('notification.settings.tab.customers'), children: <CustomerPreferencesPanel /> },
        ]}
      />
    </div>
  );
}
