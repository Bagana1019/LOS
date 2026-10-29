'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Button, Empty, Flex, Input, Select, Table, Tag, Tooltip, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { DeliveryView } from '@los/contracts';
import { t } from '../../lib/i18n';
import { NotificationErrorAlert } from './NotificationErrorAlert';
import {
  CHANNEL_COLOR, DELIVERY_STATUSES, NOTIFICATION_CHANNELS, STATUS_COLOR, channelKey, deliveryErrorLabel, formatDateTime, isRetrying, notificationHref, recipientTypeKey, shortId, statusKey,
  typeKey, type DeliveryFilter,
} from './notifications.utils';
import { useDeliveries } from './useNotificationAdmin';

const PAGE_SIZES = ['10', '20', '50', '100'];
const FIRST_PAGE: DeliveryFilter = { page: 1, pageSize: 20 };
const dash = () => t('notification.common.empty');

/** Хүргэлтийн бүртгэл (SMS/Email/Push): ADMIN бүгдийг, BRANCH_MANAGER өөрийн салбарын хүсэлтийн хүргэлтийг харна. Хаяг нуугдмал. */
export function DeliveriesPanel() {
  const [filter, setFilter] = useState<DeliveryFilter>(FIRST_PAGE);
  const [applicationDraft, setApplicationDraft] = useState('');
  const q = useDeliveries(filter);

  const change = (patch: Partial<DeliveryFilter>) => setFilter((f) => ({ ...f, ...patch, page: 1 }));
  const reset = () => {
    setFilter(FIRST_PAGE);
    setApplicationDraft('');
  };

  const columns: TableColumnsType<DeliveryView> = [
    { title: t('notification.deliveries.column.scheduledFor'), key: 'scheduledFor', width: 140, render: (_, r) => formatDateTime(r.scheduledFor) },
    { title: t('notification.deliveries.column.type'), key: 'type', width: 180, render: (_, r) => t(typeKey(r.type)) },
    { title: t('notification.deliveries.column.channel'), key: 'channel', width: 90, render: (_, r) => <Tag color={CHANNEL_COLOR[r.channel]}>{t(channelKey(r.channel))}</Tag> },
    {
      title: t('notification.deliveries.column.recipient'),
      key: 'recipient',
      width: 190,
      render: (_, r) => (
        <Flex vertical>
          <Typography.Text>{r.addressMasked ?? dash()}</Typography.Text>
          <Typography.Text type="secondary">{t(recipientTypeKey(r.recipientType))}</Typography.Text>
        </Flex>
      ),
    },
    {
      title: t('notification.deliveries.column.application'),
      key: 'application',
      width: 110,
      render: (_, r) => {
        const href = notificationHref(r);
        return href && r.applicationId ? (
          <Tooltip title={r.applicationId}><Link href={href}>{shortId(r.applicationId)}</Link></Tooltip>
        ) : (
          dash()
        );
      },
    },
    {
      title: t('notification.deliveries.column.status'),
      key: 'status',
      width: 150,
      render: (_, r) => (
        <Flex vertical align="flex-start">
          <Tag color={STATUS_COLOR[r.status]}>{t(statusKey(r.status))}</Tag>
          {isRetrying(r) ? <Typography.Text type="secondary">{t('notification.deliveries.retrying')}</Typography.Text> : null}
        </Flex>
      ),
    },
    { title: t('notification.deliveries.column.attempts'), dataIndex: 'attempts', key: 'attempts', width: 90, align: 'right' },
    {
      title: t('notification.deliveries.column.error'),
      key: 'error',
      width: 190,
      render: (_, r) => {
        const label = deliveryErrorLabel(r.lastError, t);
        return label ? <Tooltip title={r.lastError}><Typography.Text type={r.status === 'FAILED' ? 'danger' : 'secondary'}>{label}</Typography.Text></Tooltip> : dash();
      },
    },
    { title: t('notification.deliveries.column.sentAt'), key: 'sentAt', width: 140, render: (_, r) => (r.sentAt ? formatDateTime(r.sentAt) : dash()) },
  ];

  return (
    <Flex vertical gap={16}>
      <Flex gap={12} wrap align="center">
        <Select<DeliveryFilter['status']>
          style={{ width: 160 }}
          allowClear
          placeholder={t('notification.deliveries.filter.status')}
          value={filter.status}
          onChange={(status) => change({ status })}
          options={DELIVERY_STATUSES.map((s) => ({ value: s, label: t(statusKey(s)) }))}
        />
        <Select<DeliveryFilter['channel']>
          style={{ width: 160 }}
          allowClear
          placeholder={t('notification.deliveries.filter.channel')}
          value={filter.channel}
          onChange={(channel) => change({ channel })}
          options={NOTIFICATION_CHANNELS.map((c) => ({ value: c, label: t(channelKey(c)) }))}
        />
        <Input.Search
          style={{ width: 300 }}
          allowClear
          placeholder={t('notification.deliveries.filter.application')}
          enterButton={t('notification.deliveries.filter.search')}
          value={applicationDraft}
          onChange={(e) => {
            setApplicationDraft(e.target.value);
            if (e.target.value === '') change({ applicationId: undefined });
          }}
          onSearch={(value) => change({ applicationId: value.trim() || undefined })}
        />
        <Button onClick={reset}>{t('notification.deliveries.filter.reset')}</Button>
        <Button onClick={() => void q.refetch()} loading={q.isFetching && !q.isLoading}>{t('notification.common.refresh')}</Button>
      </Flex>

      {q.isError ? <NotificationErrorAlert error={q.error} title={t('notification.deliveries.loadError')} onRetry={() => void q.refetch()} /> : null}

      <Table<DeliveryView>
        rowKey="id"
        columns={columns}
        dataSource={q.data?.items ?? []}
        loading={q.isLoading || (q.isFetching && q.isPlaceholderData)}
        size="middle"
        scroll={{ x: 1180 }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('notification.deliveries.empty')} /> }}
        pagination={{
          current: filter.page,
          pageSize: filter.pageSize,
          total: q.data?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: PAGE_SIZES,
          showTotal: (total) => t('notification.deliveries.total', { total }),
          onChange: (page, pageSize) => setFilter((f) => (pageSize !== f.pageSize ? { ...f, pageSize, page: 1 } : { ...f, page })),
        }}
      />
    </Flex>
  );
}
