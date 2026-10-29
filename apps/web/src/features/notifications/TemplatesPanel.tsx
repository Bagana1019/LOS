'use client';
import { useMemo, useState } from 'react';
import { Alert, Button, Empty, Flex, Select, Skeleton, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { TemplateView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { NotificationErrorAlert } from './NotificationErrorAlert';
import { TemplateEditModal } from './TemplateEditModal';
import {
  CHANNEL_COLOR, NOTIFICATION_CHANNELS, NOTIFICATION_TYPES, channelKey, filterTemplates, sourceKey, templateRowKey, templateSource, truncate, typeKey, type TemplateFilter, type TemplateSource,
} from './notifications.utils';
import { useTemplates } from './useNotificationAdmin';

const SOURCE_COLOR: Record<TemplateSource, string> = { BUILTIN: 'default', OVERRIDE: 'blue', OVERRIDE_INACTIVE: 'warning' };

/** Загваруудын жагсаалт (ADMIN): кодонд суулгасан + байгууллагын тусгай (override) загвар. */
export function TemplatesPanel() {
  const templates = useTemplates();
  const [filter, setFilter] = useState<TemplateFilter>({});
  const [editing, setEditing] = useState<TemplateView | null>(null);
  const rows = useMemo(() => filterTemplates(templates.data ?? [], filter), [templates.data, filter]);

  const columns: TableColumnsType<TemplateView> = [
    { title: t('notification.templates.column.type'), key: 'type', width: 190, render: (_, r) => t(typeKey(r.type)) },
    { title: t('notification.templates.column.channel'), key: 'channel', width: 100, render: (_, r) => <Tag color={CHANNEL_COLOR[r.channel]}>{t(channelKey(r.channel))}</Tag> },
    { title: t('notification.templates.column.subject'), key: 'subject', width: 220, render: (_, r) => (r.subject ? truncate(r.subject, 40) : t('notification.common.empty')) },
    {
      title: t('notification.templates.column.body'),
      key: 'body',
      render: (_, r) => (
        <Tooltip title={<span style={{ whiteSpace: 'pre-wrap' }}>{r.body}</span>}>
          <Typography.Text>{truncate(r.body, 90)}</Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: t('notification.templates.column.source'),
      key: 'source',
      width: 160,
      render: (_, r) => {
        const source = templateSource(r);
        return <Tag color={SOURCE_COLOR[source]}>{t(sourceKey(source))}</Tag>;
      },
    },
    {
      title: t('notification.templates.column.actions'),
      key: 'actions',
      width: 90,
      fixed: 'right',
      render: (_, r) => <Button type="link" size="small" onClick={() => setEditing(r)}>{t('notification.templates.edit')}</Button>,
    },
  ];

  return (
    <Flex vertical gap={16}>
      <Alert type="info" showIcon message={t('notification.templates.hint')} />

      <Flex gap={12} wrap align="center">
        <Select<TemplateFilter['type']>
          style={{ width: 220 }}
          allowClear
          placeholder={t('notification.templates.filter.type')}
          value={filter.type}
          onChange={(type) => setFilter((f) => ({ ...f, type }))}
          options={NOTIFICATION_TYPES.map((type) => ({ value: type, label: t(typeKey(type)) }))}
        />
        <Select<TemplateFilter['channel']>
          style={{ width: 160 }}
          allowClear
          placeholder={t('notification.templates.filter.channel')}
          value={filter.channel}
          onChange={(channel) => setFilter((f) => ({ ...f, channel }))}
          options={NOTIFICATION_CHANNELS.map((channel) => ({ value: channel, label: t(channelKey(channel)) }))}
        />
        <Button onClick={() => void templates.refetch()} loading={templates.isFetching && !templates.isLoading}>{t('notification.common.refresh')}</Button>
      </Flex>

      {templates.isError ? (
        <NotificationErrorAlert error={templates.error} title={t('notification.templates.loadError')} onRetry={() => void templates.refetch()} />
      ) : templates.isLoading ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : (
        <Table<TemplateView>
          rowKey={templateRowKey}
          columns={columns}
          dataSource={rows}
          size="middle"
          scroll={{ x: 1000 }}
          pagination={{ defaultPageSize: 12, pageSizeOptions: ['12', '24', '50'], showSizeChanger: true, hideOnSinglePage: true }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('notification.templates.empty')} /> }}
        />
      )}

      {editing ? <TemplateEditModal key={templateRowKey(editing)} template={editing} onClose={() => setEditing(null)} /> : null}
    </Flex>
  );
}
