'use client';
import { useState } from 'react';
import { App, Alert, Button, Flex, Input, Modal, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { t } from '../../lib/i18n';
import type { SettingView } from './admin.api';
import { errorText, parseJsonInput, showValue } from './admin.utils';
import { useSaveSetting, useSettings } from './admin.hooks';
import { BackLink } from './SettingsHome';

/** FR-13 · `setting` хүснэгтийн бүх түлхүүр (BR-1…BR-13, хуучралт, retention, BSA босго). Утгыг сервер бүртгэлийн схемээр шалгана. */
export function ParametersPage() {
  const { message } = App.useApp();
  const settings = useSettings();
  const save = useSaveSetting();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<SettingView | null>(null);
  const [text, setText] = useState('');
  const parsed = parseJsonInput(text);
  const rows = (settings.data ?? []).filter((s) => !q || `${s.key} ${s.description}`.toLowerCase().includes(q.toLowerCase()));

  const open = (s: SettingView) => { setEditing(s); setText(JSON.stringify(s.value, null, 2)); };
  const onSave = () => {
    if (!editing || !parsed.ok) return;
    save.mutate({ key: editing.key, value: parsed.value }, {
      onSuccess: () => { void message.success(t('admin.params.saved')); setEditing(null); },
      onError: (e) => void message.error(errorText(e)),
    });
  };

  const columns: TableColumnsType<SettingView> = [
    { title: t('admin.params.col.key'), dataIndex: 'key', width: 280, render: (k: string) => <Typography.Text code>{k}</Typography.Text> },
    { title: t('admin.params.col.desc'), dataIndex: 'description' },
    { title: t('admin.params.col.value'), width: 220, render: (_, s) => <Typography.Text ellipsis={{ tooltip: showValue(s.value) }} style={{ maxWidth: 200 }}>{showValue(s.value)}</Typography.Text> },
    { title: t('admin.params.col.source'), width: 120, render: (_, s) => <Tag color={s.isDefault ? 'default' : 'blue'}>{t(s.isDefault ? 'admin.params.default' : 'admin.params.custom')}</Tag> },
    { title: '', width: 90, render: (_, s) => <Button type="link" size="small" onClick={() => open(s)}>{t('admin.common.edit')}</Button> },
  ];

  return (
    <Flex vertical gap={16}>
      <BackLink />
      <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.params.title')}</Typography.Title>
      <Alert type="info" showIcon message={t('admin.params.hint')} />
      <Input.Search allowClear placeholder={t('admin.params.search')} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
      {settings.isError ? <Alert type="error" showIcon message={t('admin.common.load_error')} description={errorText(settings.error)} /> : settings.isLoading ? <Skeleton active /> : (
        <Table<SettingView> rowKey="key" size="small" columns={columns} dataSource={rows} pagination={{ pageSize: 25, hideOnSinglePage: true }} scroll={{ x: 900 }} />
      )}
      <Modal open={!!editing} title={t('admin.params.edit_title')} onCancel={() => setEditing(null)} okText={t('admin.common.save')} cancelText={t('admin.common.cancel')}
        onOk={onSave} okButtonProps={{ disabled: !parsed.ok, loading: save.isPending }} destroyOnClose>
        {editing ? (
          <Flex vertical gap={8}>
            <Typography.Text code>{editing.key}</Typography.Text>
            <Typography.Text type="secondary">{editing.description}</Typography.Text>
            <Input.TextArea rows={6} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} style={{ fontFamily: 'monospace' }} status={parsed.ok ? undefined : 'error'} />
            <Typography.Text type={parsed.ok ? 'secondary' : 'danger'}>{parsed.ok ? t('admin.params.json_hint') : t('admin.params.invalid_json')}</Typography.Text>
          </Flex>
        ) : null}
      </Modal>
    </Flex>
  );
}
