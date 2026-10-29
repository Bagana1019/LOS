'use client';
import { useState } from 'react';
import { App as AntApp, Alert, Button, Card, Empty, Flex, Input, Skeleton, Switch, Typography } from 'antd';
import type { NotificationChannel } from '@los/contracts';
import { t } from '../../lib/i18n';
import { NotificationErrorAlert } from './NotificationErrorAlert';
import { channelKey, draftFromView, toPreferenceRequest, type PreferenceDraft } from './notifications.utils';
import { usePreferences, useSavePreferences } from './useNotificationAdmin';

/**
 * Зээлдэгчийн мэдэгдлийн суваг тус бүрийн opt-out (SMS / Имэйл / Push). ADMIN, эсвэл өөрийн хүсэлтийн зээлдэгчийн өмнөөс ЗЭЗ.
 * Өөр хуудсанд (харилцагч, зээлдэгчийн алхам) шууд залгаж болохоор `customerId`-аар ажиллана.
 */
export function CustomerChannelPreferences({ customerId }: { customerId: string }) {
  const { message } = AntApp.useApp();
  const q = usePreferences('CUSTOMER', customerId);
  const save = useSavePreferences('CUSTOMER', customerId);
  const [changes, setChanges] = useState<PreferenceDraft>({});

  if (q.isError) return <NotificationErrorAlert error={q.error} title={t('notification.preferences.loadError')} onRetry={() => void q.refetch()} />;
  if (q.isLoading || !q.data) return <Skeleton active paragraph={{ rows: 3 }} />;

  const view = q.data;
  const draft: PreferenceDraft = { ...draftFromView(view), ...changes };
  const request = toPreferenceRequest(view, draft);
  const onSave = () => {
    if (!request) return;
    save.mutate(request, {
      onSuccess: () => {
        setChanges({});
        void message.success(t('notification.preferences.saved'));
      },
    });
  };

  return (
    <Flex vertical gap={16}>
      {save.isError ? <NotificationErrorAlert error={save.error} title={t('notification.preferences.saveError')} /> : null}
      {view.channels.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}
      {view.channels.map(({ channel }) => (
        <Flex key={channel} align="center" justify="space-between" gap={16} style={{ maxWidth: 520 }}>
          <Flex vertical>
            <Typography.Text strong id={`pref-${channel}`}>{t(channelKey(channel as NotificationChannel))}</Typography.Text>
            <Typography.Text type="secondary">{t(`notification.preferences.desc.${channel}`)}</Typography.Text>
          </Flex>
          <Flex align="center" gap={8}>
            <Typography.Text type={draft[channel] ? undefined : 'secondary'}>{t(draft[channel] ? 'notification.preferences.enabled' : 'notification.preferences.disabled')}</Typography.Text>
            <Switch aria-labelledby={`pref-${channel}`} checked={draft[channel] ?? true} onChange={(enabled) => setChanges((c) => ({ ...c, [channel]: enabled }))} />
          </Flex>
        </Flex>
      ))}
      <Flex gap={8}>
        <Button type="primary" disabled={!request} loading={save.isPending} onClick={onSave}>{t('notification.common.save')}</Button>
        {!request ? <Typography.Text type="secondary" style={{ alignSelf: 'center' }}>{t('notification.preferences.noChanges')}</Typography.Text> : null}
      </Flex>
    </Flex>
  );
}

/** Тохиргооны хуудасны таб: харилцагчийн ID-аар хайж суваг тохируулна. */
export function CustomerPreferencesPanel() {
  const [draftId, setDraftId] = useState('');
  const [customerId, setCustomerId] = useState<string | null>(null);

  return (
    <Card title={t('notification.preferences.title')}>
      <Flex vertical gap={16}>
        <Alert type="info" showIcon message={t('notification.preferences.hint')} />
        <Input.Search
          style={{ maxWidth: 520 }}
          allowClear
          value={draftId}
          placeholder={t('notification.preferences.customerId')}
          enterButton={t('notification.preferences.load')}
          aria-label={t('notification.preferences.customerId')}
          onChange={(e) => {
            setDraftId(e.target.value);
            if (e.target.value === '') setCustomerId(null);
          }}
          onSearch={(value) => setCustomerId(value.trim() || null)}
        />
        {customerId ? <CustomerChannelPreferences key={customerId} customerId={customerId} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('notification.preferences.empty')} />}
      </Flex>
    </Card>
  );
}
