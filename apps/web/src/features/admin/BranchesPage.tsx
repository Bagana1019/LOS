'use client';
import { useEffect, useMemo, useState } from 'react';
import { App, Alert, Button, Card, Flex, Form, Input, Modal, Popconfirm, Skeleton, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { CreateBranchBody, SETTING_TARGET_TYPE, UpdateBranchBody, type AdminBranchDto } from '@los/contracts';
import { t } from '../../lib/i18n';
import { errorText, validateBranchCodes } from './admin.utils';
import { useBranches, useCreateBranch, useProposeSetting, useSetBranchActive, useSettings, useUpdateBranch } from './admin.hooks';
import { BackLink } from './SettingsHome';
import { PendingChangeNotice, ReasonField, reasonOk, submittedText } from './FourEyes';

const KEY = 'contract.branch_codes';

/** FR-13 · Салбарын удирдлага (нэмэх, засах, идэвхгүй болгох/сэргээх — устгахгүй) + BR-11 салбарын код (`contract.branch_codes`, 4 нүд). */
export function BranchesPage() {
  const { message } = App.useApp();
  const branches = useBranches();
  const settings = useSettings();
  const saveSetting = useProposeSetting();
  const create = useCreateBranch();
  const update = useUpdateBranch();
  const setActive = useSetBranchActive();
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState<AdminBranchDto | 'new' | null>(null);
  const [form] = Form.useForm<{ code: string; name: string }>();
  const saved = useMemo(() => (settings.data?.find((s) => s.key === KEY)?.value ?? {}) as Record<string, string>, [settings.data]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  useEffect(() => setCodes(saved), [saved]);
  const codeError = validateBranchCodes(codes);

  const open = (b: AdminBranchDto | 'new') => { form.resetFields(); if (b !== 'new') form.setFieldsValue({ name: b.name, code: b.code }); setEditing(b); };
  const onSubmit = () => {
    const v = form.getFieldsValue();
    const done = (key: string) => ({ onSuccess: () => { setEditing(null); void message.success(t(key as never)); }, onError: (e: unknown) => void message.error(errorText(e)) });
    if (editing === 'new') {
      const p = CreateBranchBody.safeParse(v);
      if (!p.success) return void message.error(p.error.issues[0]?.message ?? t('admin.common.load_error'));
      create.mutate(p.data, done('admin.branches.created'));
    } else if (editing) {
      const p = UpdateBranchBody.safeParse(v);
      if (!p.success) return void message.error(p.error.issues[0]?.message ?? t('admin.common.load_error'));
      update.mutate({ id: editing.id, body: p.data }, done('admin.branches.updated'));
    }
  };
  const toggle = (b: AdminBranchDto) =>
    setActive.mutate({ id: b.id, active: !b.isActive }, { onSuccess: () => void message.success(t(b.isActive ? 'admin.branches.deactivated' : 'admin.branches.reactivated')), onError: (e) => void message.error(errorText(e)) });
  const onSaveCodes = () => {
    const clean = Object.fromEntries(Object.entries(codes).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
    saveSetting.mutate({ key: KEY, value: clean, reason: reason.trim() }, { onSuccess: (r) => { setReason(''); void message.success(submittedText(r, 'admin.branches.codes.applied_direct')); }, onError: (e) => void message.error(errorText(e)) });
  };

  const listCols: TableColumnsType<AdminBranchDto> = [
    { title: t('admin.branches.field.code'), dataIndex: 'code', width: 120 },
    { title: t('admin.branches.col.name'), dataIndex: 'name' },
    { title: t('admin.branches.col.users'), dataIndex: 'activeUserCount', width: 150, align: 'right' },
    { title: t('admin.branches.col.status'), width: 130, render: (_, b) => <Tag color={b.isActive ? 'green' : 'default'}>{t(b.isActive ? 'admin.branches.active' : 'admin.branches.inactive')}</Tag> },
    {
      title: t('admin.branches.col.actions'), width: 230,
      render: (_, b) => (
        <Space>
          <Button size="small" onClick={() => open(b)}>{t('admin.branches.edit')}</Button>
          {b.isActive ? (
            <Popconfirm title={t('admin.branches.deactivate.confirm')} okText={t('admin.branches.deactivate')} cancelText={t('admin.common.cancel')} onConfirm={() => toggle(b)}>
              <Button size="small" danger>{t('admin.branches.deactivate')}</Button>
            </Popconfirm>
          ) : <Button size="small" onClick={() => toggle(b)}>{t('admin.branches.reactivate')}</Button>}
        </Space>
      ),
    },
  ];
  const codeCols: TableColumnsType<AdminBranchDto> = [
    { title: t('admin.branches.col.name'), dataIndex: 'name' },
    {
      title: t('admin.branches.col.code'), width: 180,
      render: (_, b) => <Input value={codes[b.id] ?? ''} maxLength={12} placeholder={b.code} onChange={(e) => setCodes((c) => ({ ...c, [b.id]: e.target.value }))} aria-label={`${t('admin.branches.col.code')} ${b.name}`} />,
    },
  ];

  const err = branches.error ?? settings.error;
  return (
    <Flex vertical gap={16}>
      <BackLink />
      <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.branches.title')}</Typography.Title>
      {err ? <Alert type="error" showIcon message={t('admin.common.load_error')} description={errorText(err)} /> : null}
      <Card title={t('admin.branches.list.title')} extra={<Button type="primary" onClick={() => open('new')}>{t('admin.branches.add')}</Button>}>
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">{t('admin.branches.list.hint')}</Typography.Text>
          {branches.isLoading ? <Skeleton active /> : <Table<AdminBranchDto> rowKey="id" size="small" aria-label={t('admin.branches.list.title')} pagination={false} columns={listCols} dataSource={branches.data ?? []} scroll={{ x: 640 }} />}
        </Flex>
      </Card>
      <Card title={t('admin.branches.codes.title')} extra={<Button type="primary" onClick={onSaveCodes} loading={saveSetting.isPending} disabled={!!codeError || !reasonOk(reason)}>{t('admin.four_eyes.submit')}</Button>}>
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">{t('admin.branches.codes.hint')}</Typography.Text>
          <PendingChangeNotice targetType={SETTING_TARGET_TYPE} targetId={KEY} />
          <Alert type="info" showIcon message={t('admin.four_eyes.notice')} />
          <ReasonField value={reason} onChange={setReason} />
          {codeError ? <Alert type="error" showIcon message={codeError} /> : null}
          {branches.isLoading ? <Skeleton active /> : <Table<AdminBranchDto> rowKey="id" size="small" pagination={false} columns={codeCols} dataSource={branches.data ?? []} />}
        </Flex>
      </Card>
      <Modal open={editing !== null} title={t(editing === 'new' ? 'admin.branches.create.title' : 'admin.branches.edit.title')} okText={t('admin.common.save')} cancelText={t('admin.common.cancel')}
        confirmLoading={create.isPending || update.isPending} onOk={onSubmit} onCancel={() => setEditing(null)} destroyOnClose forceRender>
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="code" label={t('admin.branches.field.code')} extra={t('admin.branches.field.code.help')}>
            <Input maxLength={12} disabled={editing !== 'new'} autoComplete="off" />
          </Form.Item>
          <Form.Item name="name" label={t('admin.branches.field.name')}><Input maxLength={120} autoComplete="off" /></Form.Item>
        </Form>
      </Modal>
    </Flex>
  );
}
