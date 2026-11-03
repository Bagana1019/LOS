'use client';
import { useEffect, useMemo, useState } from 'react';
import { App, Alert, Button, Flex, InputNumber, Input, Select, Skeleton, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { validateApprovalLevels, type ApprovalLevelInput } from '@los/contracts';
import { t, formatMoney } from '../../lib/i18n';
import { errorText } from './admin.utils';
import { useLevels, useSaveLevels, useUsers } from './admin.hooks';
import { BackLink } from './SettingsHome';

type Row = ApprovalLevelInput;
const APPROVER_ROLES = ['APPROVER', 'BRANCH_MANAGER', 'ADMIN'];

/** BR-13 · Зээлийн дүнгээр шатлах батлах түвшин, босго, SLA, батлагчид. Босго завсаргүй байх шалгалт `validateApprovalLevels` (сервер давхар шалгана). */
export function ApprovalLevelsPage() {
  const { message } = App.useApp();
  const levels = useLevels();
  const users = useUsers();
  const save = useSaveLevels();
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => { if (levels.data) setRows(levels.data.map(({ id: _id, ...r }) => r)); }, [levels.data]);

  const error = useMemo(() => validateApprovalLevels(rows), [rows]);
  const userOptions = (users.data ?? []).filter((u) => u.isActive && u.roles.some((r) => APPROVER_ROLES.includes(r))).map((u) => ({ value: u.id, label: `${u.fullName} (${u.username})` }));
  const patch = (i: number, p: Partial<Row>) => setRows((rs) => {
    const next = rs.map((r, j) => (j === i ? { ...r, ...p } : r));
    // Дээд дүн өөрчлөгдвөл дараагийн түвшний доод дүн дагана (завсар үүсгэхгүй)
    if ('amountTo' in p && next[i + 1] && p.amountTo != null) next[i + 1] = { ...next[i + 1]!, amountFrom: p.amountTo };
    return next;
  });
  const add = () => setRows((rs) => {
    const last = rs[rs.length - 1];
    const from = last?.amountTo ?? (last ? last.amountFrom + 1_000_000 : 0);
    const fixed = rs.map((r, j) => (j === rs.length - 1 ? { ...r, amountTo: from } : r));
    return [...fixed, { levelNo: rs.length + 1, name: '', amountFrom: from, amountTo: null, quorumType: 'MAJORITY', slaHours: 24, members: [] }];
  });
  const removeLast = () => setRows((rs) => (rs.length <= 1 ? rs : rs.slice(0, -1).map((r, j, a) => (j === a.length - 1 ? { ...r, amountTo: null } : r))));

  const columns: TableColumnsType<Row> = [
    { title: t('admin.levels.col.no'), dataIndex: 'levelNo', width: 56 },
    { title: t('admin.levels.col.name'), width: 180, render: (_, r, i) => <Input value={r.name} maxLength={120} onChange={(e) => patch(i, { name: e.target.value })} /> },
    { title: t('admin.levels.col.from'), width: 150, render: (_, r) => formatMoney(r.amountFrom, 'MNT') },
    {
      title: t('admin.levels.col.to'), width: 190,
      render: (_, r, i) => (i === rows.length - 1
        ? <Typography.Text type="secondary">{t('admin.levels.unbounded')}</Typography.Text>
        : <InputNumber style={{ width: '100%' }} min={1} step={1_000_000} value={r.amountTo ?? undefined} onChange={(v) => patch(i, { amountTo: v == null ? null : Number(v) })} />),
    },
    { title: t('admin.levels.col.sla'), width: 110, render: (_, r, i) => <InputNumber min={1} max={720} value={r.slaHours} onChange={(v) => patch(i, { slaHours: Number(v ?? 24) })} /> },
    {
      title: t('admin.levels.col.members'),
      render: (_, r, i) => (
        <Select mode="multiple" style={{ width: '100%' }} placeholder={t('admin.levels.members.placeholder')} loading={users.isLoading} options={userOptions} optionFilterProp="label"
          value={r.members.map((m) => m.userId)} onChange={(ids: string[]) => patch(i, { members: ids.map((userId) => ({ userId })) })}
          status={r.members.length === 0 ? 'warning' : undefined} />
      ),
    },
  ];

  const onSave = () => save.mutate({ levels: rows }, {
    onSuccess: () => void message.success(t('admin.levels.saved')),
    onError: (e) => void message.error(errorText(e)),
  });

  return (
    <Flex vertical gap={16}>
      <BackLink />
      <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.levels.title')}</Typography.Title>
      <Alert type="info" showIcon message={t('admin.levels.hint')} />
      {levels.isError ? <Alert type="error" showIcon message={t('admin.common.load_error')} description={errorText(levels.error)} action={<Button onClick={() => void levels.refetch()}>{t('admin.common.refresh')}</Button>} />
        : levels.isLoading ? <Skeleton active />
        : (
          <>
            <Table<Row> rowKey="levelNo" size="small" pagination={false} columns={columns} dataSource={rows} scroll={{ x: 900 }} />
            {rows.some((r) => r.members.length === 0) ? <Alert type="warning" showIcon message={t('admin.levels.empty_members')} /> : null}
            {error ? <Alert type="error" showIcon message={error} /> : null}
            <Flex gap={8} wrap>
              <Button onClick={add} disabled={rows.length >= 10}>{t('admin.levels.add')}</Button>
              <Button onClick={removeLast} disabled={rows.length <= 1}>{t('admin.levels.remove_last')}</Button>
              <Button onClick={() => levels.data && setRows(levels.data.map(({ id: _id, ...r }) => r))}>{t('admin.levels.reset')}</Button>
              <Button type="primary" onClick={onSave} loading={save.isPending} disabled={!!error || rows.length === 0}>{t('admin.common.save')}</Button>
            </Flex>
          </>
        )}
    </Flex>
  );
}
