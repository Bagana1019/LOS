'use client';
import { useEffect, useState } from 'react';
import { App, Alert, Button, Flex, Input, InputNumber, Radio, Select, Skeleton, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { RiskBand, type PricingTierInput } from '@los/contracts';
import { t } from '../../lib/i18n';
import { ApiError } from '../../lib/api';
import { errorText } from './admin.utils';
import { usePricingTiers, useProducts, useSavePricingTiers } from './admin.hooks';
import { BackLink } from './SettingsHome';

const NEW_TIER = (n: number): PricingTierInput => ({ code: `T${n}`, name: '', band: 'YELLOW', minScore: 0, interestRate: 0, feeRate: 0, isDefault: false });

/** FR-5.5 · Sosco Score-оос хамаарсан хүү/шимтгэлийн шатлал. Нийтлэг эсвэл бүтээгдэхүүн тус бүр. Шатлалын шалгалтыг сервер хийнэ (422 → мессеж). Шууд хадгална (settings:manage, аудитлагдана). */
export function PricingTiersPage() {
  const { message } = App.useApp();
  const products = useProducts();
  const [scope, setScope] = useState<string>('');
  const tiers = usePricingTiers(scope || null);
  const save = useSavePricingTiers();
  const [rows, setRows] = useState<PricingTierInput[]>([]);
  useEffect(() => { setRows(tiers.data?.tiers.map((r) => ({ ...r })) ?? []); }, [tiers.data]);
  const notConfigured = tiers.isError && tiers.error instanceof ApiError && tiers.error.status === 404;

  const patch = (i: number, p: Partial<PricingTierInput>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const columns: TableColumnsType<PricingTierInput> = [
    { title: t('admin.pricing.col.code'), width: 110, render: (_, r, i) => <Input value={r.code} maxLength={16} onChange={(e) => patch(i, { code: e.target.value.toUpperCase() })} /> },
    { title: t('admin.pricing.col.name'), width: 180, render: (_, r, i) => <Input value={r.name} maxLength={64} onChange={(e) => patch(i, { name: e.target.value })} /> },
    { title: t('admin.pricing.col.band'), width: 130, render: (_, r, i) => <Select value={r.band} style={{ width: '100%' }} options={RiskBand.map((b) => ({ value: b, label: b }))} onChange={(band) => patch(i, { band })} /> },
    { title: t('admin.pricing.col.min_score'), width: 120, render: (_, r, i) => <InputNumber min={0} max={1000} value={r.minScore} onChange={(v) => patch(i, { minScore: Number(v ?? 0) })} /> },
    { title: t('admin.pricing.col.rate'), width: 130, render: (_, r, i) => <InputNumber min={0} max={100} step={0.5} value={r.interestRate} onChange={(v) => patch(i, { interestRate: Number(v ?? 0) })} /> },
    { title: t('admin.pricing.col.fee'), width: 130, render: (_, r, i) => <InputNumber min={0} max={1} step={0.005} value={r.feeRate} onChange={(v) => patch(i, { feeRate: Number(v ?? 0) })} /> },
    { title: t('admin.pricing.col.default'), width: 90, render: (_, r, i) => <Radio checked={r.isDefault} onChange={() => setRows((rs) => rs.map((x, j) => ({ ...x, isDefault: j === i })))} /> },
    { title: '', width: 60, render: (_, __, i) => <Button size="small" disabled={rows.length <= 1} onClick={() => setRows((rs) => rs.filter((_x, j) => j !== i))}>×</Button> },
  ];

  const onSave = () => save.mutate({ productId: scope || null, tiers: rows }, {
    onSuccess: () => void message.success(t('admin.common.saved')),
    onError: (e) => void message.error(errorText(e)),
  });

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
            <Table<PricingTierInput> rowKey={(r) => r.code} size="small" pagination={false} columns={columns} dataSource={rows} scroll={{ x: 900 }} />
            <Flex gap={8} wrap>
              <Button onClick={() => setRows((rs) => [...rs, NEW_TIER(rs.length + 1)])} disabled={rows.length >= 10}>{t('admin.pricing.add')}</Button>
              <Button onClick={() => setRows(tiers.data?.tiers.map((r) => ({ ...r })) ?? [])}>{t('admin.levels.reset')}</Button>
              <Button type="primary" loading={save.isPending} disabled={rows.length === 0} onClick={onSave}>{t('admin.common.save')}</Button>
            </Flex>
          </>
        )}
    </Flex>
  );
}
