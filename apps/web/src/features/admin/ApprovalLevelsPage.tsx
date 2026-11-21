'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { App, Alert, Button, Flex, Input, Select, Skeleton, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { APPROVAL_LEVELS_TARGET_TYPE, validateApprovalLevels } from '@los/contracts';
import { MoneyInput } from '../../components/form';
import { t, formatMoney } from '../../lib/i18n';
import { errorText } from './admin.utils';
import { useLevels, useSaveLevels, useUsers } from './admin.hooks';
import { firstLevelProblem, levelProblems, levelsFromRows, patchLevel, type LevelRow } from './approval-levels-form';
import { BackLink } from './SettingsHome';
import { PendingChangeNotice, ReasonField, reasonOk, submittedText } from './FourEyes';
import { PlainNumberInput } from './PlainNumberInput';

type Row = LevelRow;

/** Тоон талбар + (байвал) доор нь алдааны мессеж. Мессежийг тест `${id}-error`-оор олно. */
function FieldCell({ id, problem, children }: { id: string; problem?: string; children: ReactNode }) {
  return (
    <Flex vertical gap={2}>
      {children}
      {problem ? <Typography.Text type="danger" role="alert" style={{ fontSize: 12 }} data-testid={`${id}-error`}>{problem}</Typography.Text> : null}
    </Flex>
  );
}
const APPROVER_ROLES = ['APPROVER', 'BRANCH_MANAGER', 'ADMIN'];

/** BR-13 · Зээлийн дүнгээр шатлах батлах түвшин, босго, SLA, батлагчид. Босго завсаргүй байх шалгалт `validateApprovalLevels` (сервер давхар шалгана). */
export function ApprovalLevelsPage() {
  const { message } = App.useApp();
  const levels = useLevels();
  const users = useUsers();
  const save = useSaveLevels();
  const [rows, setRows] = useState<Row[]>([]);
  const [reason, setReason] = useState('');
  useEffect(() => { if (levels.data) setRows(levels.data.map(({ id: _id, ...r }) => r)); }, [levels.data]);

  // Талбарын алдаа (тоо биш, хүрээнээс гарсан, хоосон) түрүүлнэ; босго завсаргүй эсэх шалгалт зөвхөн талбарууд зөв үед (NaN-д утгагүй).
  const fieldProblem = useMemo(() => firstLevelProblem(rows), [rows]);
  const error = useMemo(() => (fieldProblem ? null : validateApprovalLevels(rows)), [rows, fieldProblem]);
  const userOptions = (users.data ?? []).filter((u) => u.isActive && u.roles.some((r) => APPROVER_ROLES.includes(r))).map((u) => ({ value: u.id, label: `${u.fullName} (${u.username})` }));
  const patch = (i: number, p: Partial<Row>) => setRows((rs) => patchLevel(rs, i, p));
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
      render: (_, r, i) => {
        if (i === rows.length - 1) return <Typography.Text type="secondary">{t('admin.levels.unbounded')}</Typography.Text>;
        const problem = levelProblems(r, false).amountTo;
        // "5сая" → 5,000,000 (ойлгогдоно), "-5"/"есөн сая" → алдаа; текстийг чимээгүй өөрчлөхгүй (F2-8).
        return (
          <FieldCell id={`level-${i}-to`} problem={problem}>
            <MoneyInput data-testid={`level-${i}-to`} aria-label={t('admin.levels.col.to')} status={problem ? 'error' : undefined} value={r.amountTo} onChange={(v) => patch(i, { amountTo: v === undefined ? null : v })} />
          </FieldCell>
        );
      },
    },
    {
      title: t('admin.levels.col.sla'), width: 130,
      render: (_, r, i) => {
        const problem = levelProblems(r, i === rows.length - 1).slaHours;
        return (
          <FieldCell id={`level-${i}-sla`} problem={problem}>
            <PlainNumberInput data-testid={`level-${i}-sla`} aria-label={t('admin.levels.col.sla')} status={problem ? 'error' : undefined} value={r.slaHours} onChange={(v) => patch(i, { slaHours: v })} />
          </FieldCell>
        );
      },
    },
    {
      title: t('admin.levels.col.members'),
      render: (_, r, i) => (
        <Select mode="multiple" style={{ width: '100%' }} placeholder={t('admin.levels.members.placeholder')} loading={users.isLoading} options={userOptions} optionFilterProp="label"
          value={r.members.map((m) => m.userId)} onChange={(ids: string[]) => patch(i, { members: ids.map((userId) => ({ userId })) })}
          status={r.members.length === 0 ? 'warning' : undefined} />
      ),
    },
  ];

  const onSave = () => save.mutate({ levels: levelsFromRows(rows), reason: reason.trim() }, {
    onSuccess: (r) => { setReason(''); void message.success(submittedText(r, 'admin.levels.applied_direct')); },
    onError: (e) => void message.error(errorText(e)),
  });

  return (
    <Flex vertical gap={16}>
      <BackLink />
      <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.levels.title')}</Typography.Title>
      <Alert type="info" showIcon message={t('admin.levels.hint')} />
      <PendingChangeNotice targetType={APPROVAL_LEVELS_TARGET_TYPE} />
      {levels.isError ? <Alert type="error" showIcon message={t('admin.common.load_error')} description={errorText(levels.error)} action={<Button onClick={() => void levels.refetch()}>{t('admin.common.refresh')}</Button>} />
        : levels.isLoading ? <Skeleton active />
        : (
          <>
            <Table<Row> rowKey="levelNo" size="small" pagination={false} columns={columns} dataSource={rows} scroll={{ x: 900 }} />
            {rows.some((r) => r.members.length === 0) ? <Alert type="warning" showIcon message={t('admin.levels.empty_members')} /> : null}
            {fieldProblem ? <Alert type="error" showIcon message={fieldProblem} data-testid="level-field-problem" /> : null}
            {error ? <Alert type="error" showIcon message={error} /> : null}
            <Alert type="info" showIcon message={t('admin.four_eyes.notice')} />
            <ReasonField value={reason} onChange={setReason} />
            <Flex gap={8} wrap>
              <Button onClick={add} disabled={rows.length >= 10}>{t('admin.levels.add')}</Button>
              <Button onClick={removeLast} disabled={rows.length <= 1}>{t('admin.levels.remove_last')}</Button>
              <Button onClick={() => levels.data && setRows(levels.data.map(({ id: _id, ...r }) => r))}>{t('admin.levels.reset')}</Button>
              <Button type="primary" onClick={onSave} loading={save.isPending} disabled={!!fieldProblem || !!error || rows.length === 0 || !reasonOk(reason)}>{t('admin.four_eyes.submit')}</Button>
            </Flex>
          </>
        )}
    </Flex>
  );
}
