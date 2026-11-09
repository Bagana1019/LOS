'use client';
import { useMemo, useState } from 'react';
import { App, Alert, Button, Card, Flex, Form, Input, Modal, Popconfirm, Segmented, Select, Skeleton, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { CreateUserBody, UpdateUserBody, type AdminUserDto } from '@los/contracts';
import { t } from '../../lib/i18n';
import { useAuth } from '../../lib/auth/auth-context';
import { errorText, needsBranch, SUPPORTED_ROLES_ORDER } from './admin.utils';
import { useBranches, useCreateUser, useResetUserPassword, useSetUserActive, useUpdateUser, useUsers } from './admin.hooks';
import { BackLink } from './SettingsHome';

type FormValues = { username?: string; fullName: string; email?: string; phone?: string; roles: string[]; branchId: string | null };
type Filter = 'all' | 'active' | 'inactive';

/** FR-13 · Хэрэглэгчийн удирдлага: нэмэх, засах, дүр/салбар оноох, идэвхгүй болгох/сэргээх, нууц үг шинэчлэх. Түр нууц үгийг нэг л удаа үзүүлнэ. */
export function UsersPage() {
  const { message } = App.useApp();
  const { me } = useAuth();
  const users = useUsers();
  const branches = useBranches();
  const create = useCreateUser();
  const update = useUpdateUser();
  const setActive = useSetUserActive();
  const reset = useResetUserPassword();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<AdminUserDto | 'new' | null>(null);
  const [credential, setCredential] = useState<{ username: string; password: string } | null>(null);
  const [form] = Form.useForm<FormValues>();
  const watchedRoles = Form.useWatch('roles', form) ?? [];
  const selfId = me?.user.id;

  const rows = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase('mn');
    return (users.data ?? []).filter((u) => (filter === 'all' || u.isActive === (filter === 'active')) && (!needle || `${u.username} ${u.fullName}`.toLocaleLowerCase('mn').includes(needle)));
  }, [users.data, q, filter]);
  const branchName = (id: string | null) => (branches.data ?? []).find((b) => b.id === id)?.name ?? t('admin.users.no_branch');
  const branchOptions = (branches.data ?? []).filter((b) => b.isActive || (editing && editing !== 'new' && editing.branchId === b.id)).map((b) => ({ value: b.id, label: `${b.name}${b.isActive ? '' : ` (${t('admin.branches.inactive')})`}` }));

  const open = (u: AdminUserDto | 'new') => {
    form.resetFields();
    form.setFieldsValue(u === 'new' ? { roles: ['OFFICER'], branchId: null } : { username: u.username, fullName: u.fullName, email: u.email ?? '', phone: u.phone ?? '', roles: u.roles, branchId: u.branchId });
    setEditing(u);
  };
  const fail = (e: unknown) => void message.error(errorText(e));
  const onSubmit = () => {
    const v = form.getFieldsValue();
    if (editing === 'new') {
      const p = CreateUserBody.safeParse(v);
      if (!p.success) return void message.error(p.error.issues[0]?.message ?? t('admin.common.load_error'));
      create.mutate(p.data, { onSuccess: (r) => { setEditing(null); setCredential({ username: r.user.username, password: r.temporaryPassword }); void message.success(t('admin.users.created')); }, onError: fail });
    } else if (editing) {
      const p = UpdateUserBody.safeParse(v);
      if (!p.success) return void message.error(p.error.issues[0]?.message ?? t('admin.common.load_error'));
      update.mutate({ id: editing.id, body: p.data }, { onSuccess: () => { setEditing(null); void message.success(t('admin.users.updated')); }, onError: fail });
    }
  };
  const toggle = (u: AdminUserDto) =>
    setActive.mutate({ id: u.id, active: !u.isActive }, { onSuccess: () => void message.success(t(u.isActive ? 'admin.users.deactivated' : 'admin.users.reactivated')), onError: fail });
  const onReset = (u: AdminUserDto) => reset.mutate(u.id, { onSuccess: (r) => setCredential({ username: r.user.username, password: r.temporaryPassword }), onError: fail });
  const copy = async () => {
    try { await navigator.clipboard.writeText(credential?.password ?? ''); void message.success(t('admin.users.credential.copied')); } catch { /* clipboard боломжгүй — гараар хуулна */ }
  };

  const cols: TableColumnsType<AdminUserDto> = [
    { title: t('admin.users.col.username'), dataIndex: 'username', width: 160 },
    { title: t('admin.users.col.name'), dataIndex: 'fullName' },
    { title: t('admin.users.col.roles'), width: 200, render: (_, u) => u.roles.map((r) => <Tag key={r}>{r}</Tag>) },
    { title: t('admin.users.col.branch'), width: 180, render: (_, u) => branchName(u.branchId) },
    {
      title: t('admin.users.col.status'), width: 190,
      render: (_, u) => (
        <Space size={4} wrap>
          <Tag color={u.isActive ? 'green' : 'default'}>{t(u.isActive ? 'admin.users.status.active' : 'admin.users.status.inactive')}</Tag>
          {u.mustChangePassword ? <Tag color="orange">{t('admin.users.status.must_change')}</Tag> : null}
        </Space>
      ),
    },
    { title: t('admin.users.col.last_login'), width: 160, render: (_, u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('mn-MN') : t('admin.common.none')) },
    {
      title: t('admin.users.col.actions'), width: 330,
      render: (_, u) => {
        const self = u.id === selfId;
        return (
          <Space wrap>
            <Button size="small" onClick={() => open(u)}>{t('admin.users.edit')}</Button>
            {u.isActive ? (
              <>
                <Popconfirm title={t('admin.users.reset.confirm')} okText={t('admin.users.reset')} cancelText={t('admin.common.cancel')} onConfirm={() => onReset(u)} disabled={self}>
                  <Button size="small" disabled={self} title={self ? t('admin.users.self_hint') : undefined}>{t('admin.users.reset')}</Button>
                </Popconfirm>
                <Popconfirm title={t('admin.users.deactivate.confirm')} okText={t('admin.users.deactivate')} cancelText={t('admin.common.cancel')} onConfirm={() => toggle(u)} disabled={self}>
                  <Button size="small" danger disabled={self} title={self ? t('admin.users.self_hint') : undefined}>{t('admin.users.deactivate')}</Button>
                </Popconfirm>
              </>
            ) : <Button size="small" onClick={() => toggle(u)}>{t('admin.users.reactivate')}</Button>}
          </Space>
        );
      },
    },
  ];

  const err = users.error ?? branches.error;
  return (
    <Flex vertical gap={16}>
      <BackLink />
      <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.users.page.title')}</Typography.Title>
      {err ? <Alert type="error" showIcon message={t('admin.common.load_error')} description={errorText(err)} /> : null}
      <Card extra={<Button type="primary" onClick={() => open('new')}>{t('admin.users.add')}</Button>}>
        <Flex vertical gap={12}>
          <Typography.Text type="secondary">{t('admin.users.page.hint')}</Typography.Text>
          <Flex gap={12} wrap>
            <Input.Search allowClear style={{ maxWidth: 320 }} placeholder={t('admin.users.search')} aria-label={t('admin.users.search')} onChange={(e) => setQ(e.target.value)} />
            <Segmented<Filter> value={filter} onChange={setFilter} options={[{ value: 'all', label: t('admin.users.filter.status.all') }, { value: 'active', label: t('admin.users.filter.status.active') }, { value: 'inactive', label: t('admin.users.filter.status.inactive') }]} />
          </Flex>
          {users.isLoading ? <Skeleton active /> : <Table<AdminUserDto> rowKey="id" size="small" aria-label={t('admin.users.page.title')} locale={{ emptyText: t('admin.users.empty') }} pagination={{ pageSize: 20, hideOnSinglePage: true }} columns={cols} dataSource={rows} scroll={{ x: 1100 }} />}
        </Flex>
      </Card>

      <Modal open={editing !== null} title={t(editing === 'new' ? 'admin.users.create.title' : 'admin.users.edit.title')} okText={t('admin.common.save')} cancelText={t('admin.common.cancel')}
        confirmLoading={create.isPending || update.isPending} onOk={onSubmit} onCancel={() => setEditing(null)} destroyOnClose forceRender>
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="username" label={t('admin.users.field.username')} extra={editing === 'new' ? t('admin.users.field.username.help') : undefined}>
            <Input maxLength={40} disabled={editing !== 'new'} autoComplete="off" />
          </Form.Item>
          <Form.Item name="fullName" label={t('admin.users.field.fullname')}><Input maxLength={120} autoComplete="off" /></Form.Item>
          <Flex gap={12}>
            <Form.Item name="email" label={t('admin.users.field.email')} style={{ flex: 1 }}><Input maxLength={160} type="email" autoComplete="off" /></Form.Item>
            <Form.Item name="phone" label={t('admin.users.field.phone')} style={{ flex: 1 }}><Input maxLength={40} autoComplete="off" /></Form.Item>
          </Flex>
          <Form.Item name="roles" label={t('admin.users.field.roles')} extra={t('admin.users.field.roles.help')}>
            <Select mode="multiple" options={SUPPORTED_ROLES_ORDER.map((r) => ({ value: r, label: r }))} />
          </Form.Item>
          <Form.Item name="branchId" label={t('admin.users.field.branch')} extra={needsBranch(watchedRoles) ? t('admin.users.page.hint') : undefined}>
            <Select allowClear={!needsBranch(watchedRoles)} placeholder={t('admin.users.no_branch')} options={branchOptions} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal open={credential !== null} title={t('admin.users.credential.title')} closable={false} maskClosable={false} keyboard={false} destroyOnClose
        footer={<Button type="primary" onClick={() => setCredential(null)}>{t('admin.users.credential.close')}</Button>}>
        <Flex vertical gap={12}>
          <Alert type="warning" showIcon message={t('admin.users.credential.body')} />
          <Typography.Text>{t('admin.users.credential.user')}: <Typography.Text strong>{credential?.username}</Typography.Text></Typography.Text>
          <Space.Compact>
            <Input readOnly value={credential?.password} aria-label={t('admin.users.credential.title')} style={{ fontFamily: 'monospace' }} />
            <Button onClick={() => void copy()}>{t('admin.users.credential.copy')}</Button>
          </Space.Compact>
        </Flex>
      </Modal>
    </Flex>
  );
}
