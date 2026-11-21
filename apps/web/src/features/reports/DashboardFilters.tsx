'use client';
import { useEffect, useState } from 'react';
import { Button, Flex, Input, Select, Typography } from 'antd';
import { t } from '../../lib/i18n';
import { CURRENCIES, DEFAULT_DASHBOARD_FILTERS, sameDashboardFilters, type DashboardFilters as Filters } from './dashboard.utils';
import { LookupSelect } from './LookupSelect';
import { directoryFieldModel } from './report-lookups';
import { isIsoDate } from './reports.utils';
import { useLookups } from './useLookups';

interface Props {
  value: Filters;
  busy: boolean;
  onApply: (next: Filters) => void;
}

/** Dashboard-ын шүүлт: огноо (байдлаар), валют (холихгүй), салбар (нэрээр сонгоно, утга = id). Хүрээнээс гадуур салбарыг сервер үл тооно — үр дүнгийн "Хүрээ" мөрөнд бодит хүрээ харагдана. */
export function DashboardFilters({ value, busy, onApply }: Props) {
  const [draft, setDraft] = useState<Filters>(value);
  const serial = JSON.stringify(value);
  useEffect(() => {
    setDraft(JSON.parse(serial) as Filters);
  }, [serial]);

  const lookups = useLookups();
  const branch = directoryFieldModel('branch', draft.branchId ?? '', lookups);

  const asOfInvalid = draft.asOf !== null && !isIsoDate(draft.asOf);
  const next: Filters = { asOf: draft.asOf && isIsoDate(draft.asOf) ? draft.asOf : null, currency: draft.currency, branchId: draft.branchId?.trim() ? draft.branchId.trim() : null };
  const apply = () => onApply(next);

  return (
    <Flex vertical gap={8}>
      <Flex wrap gap={12} align="end">
        <Flex vertical gap={4}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}><label htmlFor="dashboard-asOf">{t('report.dashboard.filter.asOf')}</label></Typography.Text>
          <Input id="dashboard-asOf" type="date" style={{ width: 168 }} value={draft.asOf ?? ''} onChange={(e) => setDraft((d) => ({ ...d, asOf: e.target.value || null }))} onPressEnter={apply} />
        </Flex>
        <Flex vertical gap={4}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}><label htmlFor="dashboard-currency">{t('report.dashboard.filter.currency')}</label></Typography.Text>
          <Select
            id="dashboard-currency"
            style={{ width: 140 }}
            value={draft.currency}
            onChange={(v: string) => setDraft((d) => ({ ...d, currency: v }))}
            options={CURRENCIES.map((c) => ({ value: c, label: t(c === 'MNT' ? 'report.currency.MNT' : 'report.currency.USD') }))}
          />
        </Flex>
        <Flex vertical gap={4}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}><label htmlFor="dashboard-branch">{t('report.dashboard.filter.branch')}</label></Typography.Text>
          <LookupSelect
            id="dashboard-branch"
            label={t('report.dashboard.filter.branch')}
            kind="branch"
            value={draft.branchId ?? ''}
            options={branch.options}
            notFound={branch.notFound}
            status={lookups.status}
            width={200}
            onChange={(v) => setDraft((d) => ({ ...d, branchId: v || null }))}
          />
        </Flex>
        <Button type="primary" onClick={apply} loading={busy} disabled={asOfInvalid}>{t('report.filters.apply')}</Button>
        <Button onClick={() => onApply(DEFAULT_DASHBOARD_FILTERS)} disabled={sameDashboardFilters(value, DEFAULT_DASHBOARD_FILTERS) && sameDashboardFilters(next, DEFAULT_DASHBOARD_FILTERS)}>{t('report.filters.reset')}</Button>
      </Flex>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('report.filters.scopeHint')}</Typography.Text>
    </Flex>
  );
}
