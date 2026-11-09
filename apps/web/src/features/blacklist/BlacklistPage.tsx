'use client';
import { useState } from 'react';
import { Alert, App, Button, Drawer, Flex, Form, Input, Modal, Radio, Select, Table, Tag, Timeline, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AmlSubjectType, BlacklistSeverity, type BlacklistEntry, type BlacklistEntryInput } from '@los/contracts';
import { t } from '../../lib/i18n';
import { useAuth } from '../../lib/auth/auth-context';
import { describeCustomerError } from '../customers/customer-error';
import { useBlacklistHistory, useBlacklistList, useCreateBlacklist, useDeactivateBlacklist, useUpdateBlacklist } from './useBlacklist';
import { LIST_TYPES, REASON_CODES, SOURCES, auditActionLabel, cleanRegisterInput, listTypeLabel, maskRegister, reasonLabel, severityStyle } from './blacklist.utils';

const { Title, Text, Paragraph } = Typography;

const SeverityTag = ({ value }: { value: BlacklistSeverity }) => <Tag style={severityStyle(value)}>{t(`blacklist.severity.${value}`)}</Tag>;
const errMsg = (e: unknown) => describeCustomerError(e).message;

/** FR-13.1: дотоод хар/саарал жагсаалт. BR-9: хоёул зөвхөн анхааруулга. Бичих — `blacklist:manage` (ADMIN, COMPLIANCE, BRANCH_MANAGER), унших — `blacklist:read`. */
export function BlacklistPage() {
  const { me } = useAuth();
  const canManage = !!me && me.permissions.includes('blacklist:manage');
  const canAudit = !!me && me.permissions.includes('audit:read');

  const [q, setQ] = useState('');
  const [severity, setSeverity] = useState<BlacklistSeverity | undefined>();
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [editing, setEditing] = useState<BlacklistEntry | 'new' | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);

  const list = useBlacklistList({ q: q || undefined, severity, isActive: status === 'all' ? undefined : status === 'active', limit: pageSize, offset: (page - 1) * pageSize });
  const [deactivating, setDeactivating] = useState<BlacklistEntry | null>(null);

  const columns: ColumnsType<BlacklistEntry> = [
    { title: t('blacklist.col.severity'), key: 'severity', width: 110, render: (_, r) => <SeverityTag value={r.severity} /> },
    { title: t('blacklist.col.register'), key: 'register', render: (_, r) => <span data-testid="bl-register">{canManage ? r.registerNo : maskRegister(r.registerNo)}</span> },
    { title: t('blacklist.col.name'), dataIndex: 'name', key: 'name' },
    { title: t('blacklist.col.type'), dataIndex: 'customerType', key: 'type', render: (v: string) => t(`blacklist.customerType.${v}`) },
    { title: t('blacklist.col.listType'), dataIndex: 'listType', key: 'listType', render: (v: string) => listTypeLabel(v) },
    { title: t('blacklist.col.reason'), key: 'reason', render: (_, r) => (<><div>{reasonLabel(r.reasonCode)}</div>{r.reasonText ? <Text type="secondary">{r.reasonText}</Text> : null}</>) },
    { title: t('blacklist.col.source'), dataIndex: 'source', key: 'source', render: (v: string) => t(`blacklist.source.${v}`) },
    { title: t('blacklist.col.registeredAt'), dataIndex: 'registeredAt', key: 'at', width: 120, render: (v: string) => v.slice(0, 10) },
    { title: t('blacklist.col.validUntil'), key: 'validUntil', width: 130, render: (_, r) => (r.validUntil ? r.validUntil.slice(0, 10) : '—') },
    {
      title: t('blacklist.col.status'), key: 'status', width: 170,
      render: (_, r) => (
        <>
          <Tag color={r.isActive ? 'red' : 'default'}>{t(r.isActive ? 'blacklist.status.active' : 'blacklist.status.inactive')}</Tag>
          {r.pendingSeverity ? <Tag color="orange" data-testid="bl-pending">{t('blacklist.status.pendingBlack')}</Tag> : null}
          {!r.isActive && r.deactivationReason ? <div><Text type="secondary">{r.deactivationReason === 'AUTO_EXPIRED' ? t('blacklist.status.autoExpired') : r.deactivationReason}</Text></div> : null}
        </>
      ),
    },
    {
      title: '', key: 'actions', width: 260,
      render: (_, r) => (
        <Flex gap={4} wrap>
          {canManage ? <Button size="small" onClick={() => setEditing(r)}>{t('blacklist.action.edit')}</Button> : null}
          {canManage && r.isActive ? <Button size="small" danger onClick={() => setDeactivating(r)}>{t('blacklist.action.deactivate')}</Button> : null}
          {canAudit ? <Button size="small" type="link" onClick={() => setHistoryId(r.id)}>{t('blacklist.action.history')}</Button> : null}
        </Flex>
      ),
    },
  ];

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto' }}>
      <Flex justify="space-between" align="flex-start" wrap gap={12}>
        <div>
          <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>{t('blacklist.title')}</Title>
          <Text type="secondary">{t('blacklist.subtitle')}</Text>
        </div>
        {canManage ? <Button type="primary" data-testid="add-blacklist" onClick={() => setEditing('new')}>{t('blacklist.action.add')}</Button> : null}
      </Flex>
      <Alert style={{ marginTop: 12 }} type="info" showIcon message={t('blacklist.br9')} description={t('blacklist.legend')} />
      {!canManage && me ? <Alert style={{ marginTop: 12 }} type="warning" showIcon message={t('blacklist.readOnly')} /> : null}

      <Flex gap={8} wrap style={{ margin: '16px 0 12px' }}>
        <Input.Search allowClear placeholder={t('blacklist.search.placeholder')} style={{ maxWidth: 360 }} onSearch={(v) => { setQ(v.trim()); setPage(1); }} />
        <Select allowClear placeholder={t('blacklist.filter.allSeverities')} style={{ width: 170 }} value={severity} onChange={(v) => { setSeverity(v); setPage(1); }}
          options={BlacklistSeverity.map((v) => ({ value: v, label: t(`blacklist.severity.${v}`) }))} />
        <Select style={{ width: 170 }} value={status} onChange={(v) => { setStatus(v); setPage(1); }}
          options={[{ value: 'active', label: t('blacklist.filter.active') }, { value: 'inactive', label: t('blacklist.filter.inactive') }, { value: 'all', label: t('blacklist.filter.all') }]} />
        {list.data ? <Text type="secondary" style={{ alignSelf: 'center' }}>{t('blacklist.total', { total: list.data.total })}</Text> : null}
      </Flex>

      {list.isError ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={t('blacklist.loadError')} description={errMsg(list.error)} action={<Button size="small" onClick={() => void list.refetch()}>{t('blacklist.retry')}</Button>} /> : null}
      <Table<BlacklistEntry>
        rowKey="id" loading={list.isFetching} dataSource={list.data?.items ?? []} columns={columns} scroll={{ x: 1000 }}
        locale={{ emptyText: t('blacklist.empty') }}
        pagination={{ current: page, pageSize, total: list.data?.total ?? 0, showSizeChanger: true, onChange: (p, s) => { setPage(p); setPageSize(s); } }}
      />

      {editing ? <EntryModal entry={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      {deactivating ? <DeactivateModal entry={deactivating} onClose={() => setDeactivating(null)} /> : null}
      <HistoryDrawer id={historyId} onClose={() => setHistoryId(null)} />
    </div>
  );
}

interface FormValues { registerNo: string; customerType: BlacklistEntryInput['customerType']; name: string; severity: BlacklistSeverity; listType: string; reasonCode: string; reasonText?: string; source: BlacklistEntryInput['source']; validUntil?: string }

function DeactivateModal({ entry, onClose }: { entry: BlacklistEntry; onClose: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ reason: string }>();
  const deactivate = useDeactivateBlacklist();
  const [error, setError] = useState<string | null>(null);
  const onFinish = (v: { reason: string }) => {
    setError(null);
    deactivate.mutate({ id: entry.id, reason: v.reason.trim() }, { onSuccess: () => { void message.success(t('blacklist.deactivated')); onClose(); }, onError: (e) => setError(errMsg(e)) });
  };
  return (
    <Modal open title={t('blacklist.deactivate.title')} onCancel={onClose} okText={t('blacklist.deactivate.ok')} okButtonProps={{ danger: true }} cancelText={t('blacklist.cancel')} confirmLoading={deactivate.isPending} onOk={() => form.submit()} destroyOnHidden>
      <Paragraph type="secondary">{t('blacklist.deactivate.confirm')}</Paragraph>
      {error ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} /> : null}
      <Form form={form} layout="vertical" onFinish={onFinish}>
        <Form.Item name="reason" label={t('blacklist.field.deactivationReason')} rules={[{ required: true, whitespace: true, message: t('blacklist.field.required') }, { min: 3, message: t('blacklist.field.reasonMin') }, { max: 500 }]}>
          <Input.TextArea rows={3} maxLength={500} showCount data-testid="deactivation-reason" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function EntryModal({ entry, onClose }: { entry: BlacklistEntry | null; onClose: () => void }) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const create = useCreateBlacklist();
  const update = useUpdateBlacklist();
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending;

  const onFinish = (v: FormValues) => {
    setError(null);
    const body = { ...v, registerNo: cleanRegisterInput(v.registerNo), reasonText: v.reasonText?.trim() || undefined, validUntil: v.validUntil ? new Date(`${v.validUntil}T23:59:59`).toISOString() : undefined };
    const done = { onSuccess: () => { void message.success(t('blacklist.saved')); onClose(); }, onError: (e: unknown) => setError(errMsg(e)) };
    if (entry) update.mutate({ id: entry.id, body: { ...body, reasonText: v.reasonText?.trim() || null } }, done);
    else create.mutate(body, done);
  };

  return (
    <Modal open title={t(entry ? 'blacklist.edit.title' : 'blacklist.add.title')} onCancel={onClose} okText={t('blacklist.save')} cancelText={t('blacklist.cancel')} confirmLoading={busy} onOk={() => form.submit()} destroyOnHidden>
      <Form<FormValues> form={form} layout="vertical" onFinish={onFinish}
        initialValues={entry ? { registerNo: entry.registerNo, customerType: entry.customerType, name: entry.name, severity: entry.severity, listType: entry.listType, reasonCode: entry.reasonCode, reasonText: entry.reasonText ?? undefined, source: entry.source, validUntil: entry.validUntil?.slice(0, 10) } : { source: 'INTERNAL', customerType: 'INDIVIDUAL', severity: 'BLACK', listType: 'DELINQUENT' }}>
        {error ? <Alert type="error" showIcon style={{ marginBottom: 12 }} message={error} /> : null}
        <Form.Item name="severity" label={t('blacklist.field.severity')} rules={[{ required: true }]} extra={t('blacklist.field.severity.hint')}>
          <Radio.Group optionType="button" buttonStyle="solid" options={BlacklistSeverity.map((v) => ({ value: v, label: t(`blacklist.severity.${v}`) }))} />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(a, b) => a.severity !== b.severity}>
          {({ getFieldValue }) => getFieldValue('severity') === 'BLACK' ? <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={t('blacklist.field.blackApproval')} /> : null}
        </Form.Item>
        <Form.Item name="registerNo" label={t('blacklist.field.register')} rules={[{ required: true, message: t('blacklist.field.required') }, { max: 32 }]} normalize={cleanRegisterInput}>
          <Input autoComplete="off" maxLength={32} />
        </Form.Item>
        <Form.Item name="customerType" label={t('blacklist.field.type')} rules={[{ required: true }]}>
          <Select options={AmlSubjectType.map((v) => ({ value: v, label: t(`blacklist.customerType.${v}`) }))} />
        </Form.Item>
        <Form.Item name="name" label={t('blacklist.field.name')} rules={[{ required: true, whitespace: true, message: t('blacklist.field.required') }, { max: 200 }]}>
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item name="listType" label={t('blacklist.field.listType')} rules={[{ required: true }]}>
          <Select options={listTypeOptions(entry?.listType)} />
        </Form.Item>
        <Form.Item name="reasonCode" label={t('blacklist.field.reason')} rules={[{ required: true, message: t('blacklist.field.required') }]}>
          <Select showSearch options={reasonOptions(entry?.reasonCode)} />
        </Form.Item>
        <Form.Item name="source" label={t('blacklist.field.source')} rules={[{ required: true }]}>
          <Select options={SOURCES.map((v) => ({ value: v, label: t(`blacklist.source.${v}`) }))} />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(a, b) => a.severity !== b.severity}>
          {({ getFieldValue }) => getFieldValue('severity') === 'GREY' ? (
            <Form.Item name="validUntil" label={t('blacklist.field.validUntil')} extra={t('blacklist.field.validUntil.hint')}>
              <Input type="date" />
            </Form.Item>
          ) : null}
        </Form.Item>
        <Form.Item name="reasonText" label={t('blacklist.field.reasonText')} rules={[{ max: 2000 }]}>
          <Input.TextArea rows={3} maxLength={2000} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}

const listTypeOptions = (current?: string) => [...new Set<string>([...LIST_TYPES, ...(current ? [current] : [])])].map((v) => ({ value: v, label: listTypeLabel(v) }));
const reasonOptions = (current?: string) => [...new Set<string>([...REASON_CODES, ...(current ? [current] : [])])].map((v) => ({ value: v, label: reasonLabel(v) }));

function HistoryDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const history = useBlacklistHistory(id);
  return (
    <Drawer open={id !== null} onClose={onClose} title={t('blacklist.history.title')} width={420}>
      {history.isError ? <Alert type="error" showIcon message={errMsg(history.error)} /> : null}
      {history.data && history.data.items.length === 0 ? <Paragraph type="secondary">{t('blacklist.history.empty')}</Paragraph> : null}
      <Timeline items={(history.data?.items ?? []).map((a) => ({
        children: (
          <div>
            <Text strong>{auditActionLabel(a.action)}</Text> <Text type="secondary">{new Date(a.at).toLocaleString('mn-MN')}</Text>
            <div><Text type="secondary">{t('blacklist.history.actor')}: {a.actorId ?? '—'}</Text></div>
          </div>
        ),
      }))} />
    </Drawer>
  );
}
