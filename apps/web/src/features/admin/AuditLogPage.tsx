'use client';
import { useState } from 'react';
import { Alert, Button, DatePicker, Flex, Input, Segmented, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { AuditLogPage as Page } from '@los/contracts';
import { t } from '../../lib/i18n';
import { errorText } from './admin.utils';
import { useAudit } from './admin.hooks';
import { BackLink } from './SettingsHome';

type Item = Page['items'][number];
const json = (v: unknown) => (v == null ? '' : JSON.stringify(v));

/** FR-13.5 · Аудит лог харах: зээлийн систем (origination) ба нэвтрэлт/хэрэглэгч (gateway iam). */
export function AuditLogPage() {
  const [source, setSource] = useState<'origination' | 'auth'>('origination');
  const [f, setF] = useState<{ entity?: string; action?: string; actorId?: string; applicationId?: string; from?: string; to?: string }>({});
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const audit = useAudit(source, { ...f, page, pageSize });
  const set = (p: Partial<typeof f>) => { setF((x) => ({ ...x, ...p })); setPage(1); };

  const columns: TableColumnsType<Item> = [
    { title: t('admin.audit.col.at'), width: 170, render: (_, r) => new Date(r.at).toLocaleString('mn-MN') },
    { title: t('admin.audit.col.entity'), width: 200, render: (_, r) => <span>{r.entity}<br /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.entityId}</Typography.Text></span> },
    { title: t('admin.audit.col.action'), dataIndex: 'action', width: 220 },
    { title: t('admin.audit.col.actor'), width: 140, render: (_, r) => r.actorId ?? t('admin.common.none') },
  ];

  return (
    <Flex vertical gap={16}>
      <BackLink />
      <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.audit.title')}</Typography.Title>
      <Segmented value={source} onChange={(v) => { setSource(v as typeof source); setPage(1); }} options={[{ value: 'origination', label: t('admin.audit.source.origination') }, { value: 'auth', label: t('admin.audit.source.auth') }]} />
      <Flex gap={8} wrap>
        <Input allowClear style={{ width: 160 }} placeholder={t('admin.audit.filter.entity')} onChange={(e) => set({ entity: e.target.value || undefined })} />
        <Input allowClear style={{ width: 180 }} placeholder={t('admin.audit.filter.action')} onChange={(e) => set({ action: e.target.value || undefined })} />
        <Input allowClear style={{ width: 220 }} placeholder={t('admin.audit.filter.actor')} onChange={(e) => set({ actorId: e.target.value || undefined })} />
        {source === 'origination' ? <Input allowClear style={{ width: 220 }} placeholder={t('admin.audit.filter.application')} onChange={(e) => set({ applicationId: e.target.value || undefined })} /> : null}
        <DatePicker.RangePicker onChange={(d) => set({ from: d?.[0]?.startOf('day').toISOString(), to: d?.[1]?.endOf('day').toISOString() })} />
        <Button onClick={() => void audit.refetch()} loading={audit.isFetching}>{t('admin.common.refresh')}</Button>
      </Flex>
      {audit.isError ? <Alert type="error" showIcon message={t('admin.common.load_error')} description={errorText(audit.error)} /> : null}
      <Table<Item> rowKey="id" size="small" loading={audit.isLoading} columns={columns} dataSource={audit.data?.items ?? []} locale={{ emptyText: t('admin.audit.empty') }} scroll={{ x: 900 }}
        pagination={{ current: page, pageSize, total: audit.data?.total ?? 0, showSizeChanger: false, onChange: setPage }}
        expandable={{ rowExpandable: (r) => r.beforeJson != null || r.afterJson != null, expandedRowRender: (r) => (
          <Flex vertical gap={4} style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
            {r.beforeJson != null ? <div><b>{t('admin.audit.before')}:</b> {json(r.beforeJson)}</div> : null}
            {r.afterJson != null ? <div><b>{t('admin.audit.after')}:</b> {json(r.afterJson)}</div> : null}
          </Flex>
        ) }} />
    </Flex>
  );
}
