'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { App, Alert, Button, Flex, Input, Radio, Select, Skeleton, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { RiskBand } from '@los/contracts';
import { PercentInput } from '../../components/form';
import { t } from '../../lib/i18n';
import { ApiError } from '../../lib/api';
import { errorText } from './admin.utils';
import { usePricingTiers, useProducts, useSavePricingTiers } from './admin.hooks';
import { PlainNumberInput } from './PlainNumberInput';
import { firstTierProblem, rowsToTiers, tierProblems, tierToRow, type TierField, type TierRow } from './pricing-form';
import { BackLink } from './SettingsHome';

const NEW_TIER = (n: number): TierRow => ({ code: `T${n}`, name: '', band: 'YELLOW', minScore: 0, interestRate: 0, feePercent: 0, isDefault: false });

/** Тоон талбар + (байвал) доор нь алдааны мессеж. Мессежийг тест `${id}-error`-оор олно. */
function NumberCell({ id, problem, children }: { id: string; problem?: string; children: ReactNode }) {
  return (
    <Flex vertical gap={2}>
      {children}
      {problem ? <Typography.Text type="danger" role="alert" style={{ fontSize: 12 }} data-testid={`${id}-error`}>{problem}</Typography.Text> : null}
    </Flex>
  );
}

/** FR-5.5 · Sosco Score-оос хамаарсан хүү/шимтгэлийн шатлал. Нийтлэг эсвэл бүтээгдэхүүн тус бүр. Шатлалын шалгалтыг сервер хийнэ (422 → мессеж). Шууд хадгална (settings:manage, аудитлагдана). */
export function PricingTiersPage() {
  const { message } = App.useApp();
  const products = useProducts();
  const [scope, setScope] = useState<string>('');
  const tiers = usePricingTiers(scope || null);
  const save = useSavePricingTiers();
  const [rows, setRows] = useState<TierRow[]>([]);
  useEffect(() => { setRows(tiers.data?.tiers.map(tierToRow) ?? []); }, [tiers.data]);
  const notConfigured = tiers.isError && tiers.error instanceof ApiError && tiers.error.status === 404;

  const patch = (i: number, p: Partial<TierRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  // Тоон талбар: бичсэн текст хэвээр (чимээгүй clamp/0 байхгүй), буруу бол талбарын доор мессеж (F9-2).
  const numberCell = (field: TierField, key: 'score' | 'rate' | 'fee', i: number, r: TierRow, input: (bad: boolean) => ReactNode) => {
    const problem = tierProblems(r)[field];
    return <NumberCell id={`tier-${i}-${key}`} problem={problem}>{input(problem !== undefined)}</NumberCell>;
  };
  const columns: TableColumnsType<TierRow> = [
    { title: t('admin.pricing.col.code'), width: 110, render: (_, r, i) => <Input value={r.code} maxLength={16} onChange={(e) => patch(i, { code: e.target.value.toUpperCase() })} /> },
    { title: t('admin.pricing.col.name'), width: 180, render: (_, r, i) => <Input value={r.name} maxLength={64} onChange={(e) => patch(i, { name: e.target.value })} /> },
    { title: t('admin.pricing.col.band'), width: 130, render: (_, r, i) => <Select value={r.band} style={{ width: '100%' }} options={RiskBand.map((b) => ({ value: b, label: b }))} onChange={(band) => patch(i, { band })} /> },
    {
      title: t('admin.pricing.col.min_score'), width: 130,
      render: (_, r, i) => numberCell('minScore', 'score', i, r, (bad) => (
        <PlainNumberInput data-testid={`tier-${i}-score`} aria-label={t('admin.pricing.col.min_score')} status={bad ? 'error' : undefined} value={r.minScore} onChange={(v) => patch(i, { minScore: v })} />
      )),
    },
    {
      title: t('admin.pricing.col.rate'), width: 150,
      render: (_, r, i) => numberCell('interestRate', 'rate', i, r, (bad) => (
        <PercentInput data-testid={`tier-${i}-rate`} aria-label={t('admin.pricing.col.rate')} status={bad ? 'error' : undefined} value={r.interestRate} onChange={(v) => patch(i, { interestRate: v })} />
      )),
    },
    {
      title: t('admin.pricing.col.fee_pct'), width: 150,
      render: (_, r, i) => numberCell('feePercent', 'fee', i, r, (bad) => (
        <PercentInput data-testid={`tier-${i}-fee`} aria-label={t('admin.pricing.col.fee_pct')} status={bad ? 'error' : undefined} value={r.feePercent} onChange={(v) => patch(i, { feePercent: v })} />
      )),
    },
    { title: t('admin.pricing.col.default'), width: 90, render: (_, r, i) => <Radio checked={r.isDefault} onChange={() => setRows((rs) => rs.map((x, j) => ({ ...x, isDefault: j === i })))} /> },
    { title: '', width: 60, render: (_, __, i) => <Button size="small" disabled={rows.length <= 1} onClick={() => setRows((rs) => rs.filter((_x, j) => j !== i))}>×</Button> },
  ];

  const onSave = () => {
    // Алдаатай мөр байвал юу ч явуулахгүй: мессеж нь талбар бүрийн доор харагдана.
    const problem = firstTierProblem(rows);
    if (problem) { void message.error(`${t('admin.pricing.fix_errors')} (${problem})`); return; }
    save.mutate({ productId: scope || null, tiers: rowsToTiers(rows) }, {
      onSuccess: () => void message.success(t('admin.common.saved')),
      onError: (e) => void message.error(errorText(e)),
    });
  };

  return (
    <Flex vertical gap={16}>
      <BackLink />
      <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.pricing.title')}</Typography.Title>
      <Alert type="info" showIcon message={t('admin.pricing.hint')} />
      <Flex gap={8} align="center" wrap>
        <Typography.Text>{t('admin.pricing.scope')}</Typography.Text>
        <Select style={{ minWidth: 280 }} value={scope} onChange={setScope} loading={products.isLoading}
          options={[{ value: '', label: t('admin.pricing.scope_default') }, ...(products.data ?? []).filter((p) => p.isActive).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]} />
      </Flex>
      {tiers.isLoading ? <Skeleton active />
        : tiers.isError && !notConfigured ? <Alert type="error" showIcon message={t('admin.common.load_error')} description={errorText(tiers.error)} action={<Button onClick={() => void tiers.refetch()}>{t('admin.common.refresh')}</Button>} />
        : (
          <>
            {notConfigured ? <Alert type="warning" showIcon message={t('admin.pricing.not_configured')} /> : null}
            <Table<TierRow> rowKey={(r) => r.code} size="small" pagination={false} columns={columns} dataSource={rows} scroll={{ x: 960 }} />
            <Flex gap={8} wrap>
              <Button onClick={() => setRows((rs) => [...rs, NEW_TIER(rs.length + 1)])} disabled={rows.length >= 10}>{t('admin.pricing.add')}</Button>
              <Button onClick={() => setRows(tiers.data?.tiers.map(tierToRow) ?? [])}>{t('admin.levels.reset')}</Button>
              <Button type="primary" loading={save.isPending} disabled={rows.length === 0} onClick={onSave}>{t('admin.common.save')}</Button>
            </Flex>
          </>
        )}
    </Flex>
  );
}
