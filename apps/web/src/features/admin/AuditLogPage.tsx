'use client';
import { useState } from 'react';
import { Alert, AutoComplete, Button, DatePicker, Flex, Input, Segmented, Select, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { AuditLogPage as Page } from '@los/contracts';
import { t } from '../../lib/i18n';
import { useDirectory } from '../applications/useApplications';
import { errorText } from './admin.utils';
import { useAudit, useAuditActors, useAuditFacets, useDebouncedText } from './admin.hooks';
import { actorDisplayName, actorSelectOptions, matchesText, toTextOptions, type ActorSelectOption } from './audit-filters';
import { BackLink } from './SettingsHome';

type Item = Page['items'][number];
type Filters = { entity?: string; action?: string; actorId?: string; applicationId?: string; from?: string; to?: string };
const ACTOR_SEARCH_DEBOUNCE_MS = 250;
const json = (v: unknown) => (v == null ? '' : JSON.stringify(v));

/** FR-13.5 · Аудит лог харах: зээлийн систем (origination) ба нэвтрэлт/хэрэглэгч (gateway iam). F9-24: шүүлт нь санал болгоно, "Хэн" нь нэрээр. */
export function AuditLogPage() {
  const [source, setSource] = useState<'origination' | 'auth'>('origination');
  const [f, setF] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const [actor, setActor] = useState<ActorSelectOption | undefined>();
  const [actorSearch, setActorSearch] = useState('');
  const pageSize = 25;
  const audit = useAudit(source, { ...f, page, pageSize });
  const facets = useAuditFacets(source);
  const directory = useDirectory();
  const actors = useAuditActors(useDebouncedText(actorSearch.trim(), ACTOR_SEARCH_DEBOUNCE_MS));
  const set = (p: Partial<Filters>) => { setF((x) => ({ ...x, ...p })); setPage(1); };
  const pickActor = (choice?: ActorSelectOption) => { setActor(choice); set({ actorId: choice?.value }); };
  const textFilter = (input: string, option?: { value: string | number | null }) => matchesText(input, String(option?.value ?? ''));

  const columns: TableColumnsType<Item> = [
    { title: t('admin.audit.col.at'), width: 170, render: (_, r) => new Date(r.at).toLocaleString('mn-MN') },
    { title: t('admin.audit.col.entity'), width: 200, render: (_, r) => <span>{r.entity}<br /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.entityId}</Typography.Text></span> },
    { title: t('admin.audit.col.action'), dataIndex: 'action', width: 220 },
    { title: t('admin.audit.col.actor'), width: 160, render: (_, r) => {
      const name = actorDisplayName(directory.data?.users, r.actorId);
      return name === null ? t('admin.common.none') : <span title={r.actorId ?? undefined} style={{ wordBreak: 'break-all' }}>{name}</span>;
    } },
  ];

  return (
    <Flex vertical gap={16}>
      <BackLink />
      <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.audit.title')}</Typography.Title>
      <Segmented value={source} onChange={(v) => { setSource(v as typeof source); setPage(1); }} options={[{ value: 'origination', label: t('admin.audit.source.origination') }, { value: 'auth', label: t('admin.audit.source.auth') }]} />
      <Flex gap={8} wrap>
        <AutoComplete allowClear style={{ width: 200 }} aria-label={t('admin.audit.filter.entity')} placeholder={t('admin.audit.filter.entity')}
          options={toTextOptions(facets.data?.entities ?? [])} filterOption={textFilter} onChange={(v?: string) => set({ entity: v?.trim() || undefined })} />
        <AutoComplete allowClear style={{ width: 220 }} aria-label={t('admin.audit.filter.action')} placeholder={t('admin.audit.filter.action')}
          options={toTextOptions(facets.data?.actions ?? [])} filterOption={textFilter} onChange={(v?: string) => set({ action: v?.trim() || undefined })} />
        <Select showSearch allowClear labelInValue filterOption={false} style={{ width: 260 }} aria-label={t('admin.audit.filter.actor')} placeholder={t('admin.audit.filter.actor')}
          value={actor} options={actorSelectOptions(actors.data ?? [], actorSearch)} loading={actors.isFetching}
          notFoundContent={actors.isError ? t('admin.common.load_error') : t('admin.audit.filter.actor_empty')}
          onSearch={setActorSearch} onChange={(c?: ActorSelectOption) => pickActor(c)} />
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
