'use client';
import { useEffect, useMemo, useState } from 'react';
import { App, Alert, Button, Card, Flex, Input, Select, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { SETTING_TARGET_TYPE, type AdminBranchDto, type AdminUserDto } from '@los/contracts';
import { t } from '../../lib/i18n';
import { errorText, validateBranchCodes } from './admin.utils';
import { useAssignBranch, useBranches, useProposeSetting, useSettings, useUsers } from './admin.hooks';
import { BackLink } from './SettingsHome';
import { PendingChangeNotice, ReasonField, reasonOk, submittedText } from './FourEyes';

const KEY = 'contract.branch_codes';

/** BR-11 салбарын код (`contract.branch_codes` тохиргоо) + хэрэглэгч-салбар оноолт (gateway iam). */
export function BranchesPage() {
  const { message } = App.useApp();
  const branches = useBranches();
  const users = useUsers();
  const settings = useSettings();
  const saveSetting = useProposeSetting();
  const [reason, setReason] = useState('');
  const assign = useAssignBranch();
  const saved = useMemo(() => (settings.data?.find((s) => s.key === KEY)?.value ?? {}) as Record<string, string>, [settings.data]);
  const [codes, setCodes] = useState<Record<string, string>>({});
  useEffect(() => setCodes(saved), [saved]);
  const codeError = validateBranchCodes(codes);

  const onSaveCodes = () => {
    const clean = Object.fromEntries(Object.entries(codes).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
    saveSetting.mutate({ key: KEY, value: clean, reason: reason.trim() }, { onSuccess: (r) => { setReason(''); void message.success(submittedText(r, 'admin.branches.codes.applied_direct')); }, onError: (e) => void message.error(errorText(e)) });
  };
  const onAssign = (userId: string, branchId: string | null) =>
    assign.mutate({ userId, branchId }, { onSuccess: () => void message.success(t('admin.users.assigned')), onError: (e) => void message.error(errorText(e)) });

  const branchCols: TableColumnsType<AdminBranchDto> = [
    { title: t('admin.branches.col.name'), dataIndex: 'name' },
    { title: t('admin.branches.col.status'), width: 130, render: (_, b) => <Tag color={b.isActive ? 'green' : 'default'}>{t(b.isActive ? 'admin.branches.active' : 'admin.branches.inactive')}</Tag> },
    {
      title: t('admin.branches.col.code'), width: 180,
      render: (_, b) => <Input value={codes[b.id] ?? ''} maxLength={12} placeholder={b.code} onChange={(e) => setCodes((c) => ({ ...c, [b.id]: e.target.value }))} aria-label={`${t('admin.branches.col.code')} ${b.name}`} />,
    },
  ];
  const userCols: TableColumnsType<AdminUserDto> = [
    { title: t('admin.users.col.username'), dataIndex: 'username', width: 150 },
    { title: t('admin.users.col.name'), dataIndex: 'fullName' },
    { title: t('admin.users.col.roles'), width: 190, render: (_, u) => u.roles.map((r) => <Tag key={r}>{r}</Tag>) },
    {
      title: t('admin.users.col.branch'), width: 240,
      render: (_, u) => (
        <Select style={{ width: '100%' }} value={u.branchId ?? '__none'} loading={assign.isPending && assign.variables?.userId === u.id}
          options={[{ value: '__none', label: t('admin.users.no_branch') }, ...(branches.data ?? []).filter((b) => b.isActive || b.id === u.branchId).map((b) => ({ value: b.id, label: b.name }))]}
          onChange={(v) => onAssign(u.id, v === '__none' ? null : v)} />
      ),
    },
    { title: t('admin.users.col.last_login'), width: 170, render: (_, u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('mn-MN') : t('admin.common.none')) },
  ];

  const err = branches.error ?? users.error ?? settings.error;
  return (
    <Flex vertical gap={16}>
      <BackLink />
      <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.branches.title')}</Typography.Title>
      {err ? <Alert type="error" showIcon message={t('admin.common.load_error')} description={errorText(err)} /> : null}
      <Card title={t('admin.branches.codes.title')} extra={<Button type="primary" onClick={onSaveCodes} loading={saveSetting.isPending} disabled={!!codeError || !reasonOk(reason)}>{t('admin.four_eyes.submit')}</Button>}>
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">{t('admin.branches.codes.hint')}</Typography.Text>
          <PendingChangeNotice targetType={SETTING_TARGET_TYPE} targetId={KEY} />
          <Alert type="info" showIcon message={t('admin.four_eyes.notice')} />
          <ReasonField value={reason} onChange={setReason} />
          {codeError ? <Alert type="error" showIcon message={codeError} /> : null}
          {branches.isLoading ? <Skeleton active /> : <Table<AdminBranchDto> rowKey="id" size="small" pagination={false} columns={branchCols} dataSource={branches.data ?? []} />}
        </Flex>
      </Card>
      <Card title={t('admin.users.title')}>
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">{t('admin.users.hint')}</Typography.Text>
          {users.isLoading ? <Skeleton active /> : <Table<AdminUserDto> rowKey="id" size="small" pagination={{ pageSize: 20, hideOnSinglePage: true }} columns={userCols} dataSource={users.data ?? []} scroll={{ x: 800 }} />}
        </Flex>
      </Card>
    </Flex>
  );
}
