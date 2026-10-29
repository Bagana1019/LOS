'use client';
import { useEffect, useState } from 'react';
import { Button, Flex, Input, Select, Typography } from 'antd';
import type { ReportFilterDef } from '@los/contracts';
import { t } from '../../lib/i18n';
import { compactFilters, MAX_TEXT_LENGTH, validateFilters, type FilterValues } from './reports.utils';

interface Props {
  filters: readonly ReportFilterDef[];
  /** URL-д хэрэглэгдсэн (баталгаажсан) шүүлт. */
  values: FilterValues;
  busy: boolean;
  onApply: (values: FilterValues) => void;
  onReset: () => void;
}

const widthOf = (f: ReportFilterDef): number => (f.key === 'search' ? 320 : f.type === 'date' ? 168 : f.type === 'select' ? 200 : 180);

function Control({ filter, value, onChange, onEnter }: { filter: ReportFilterDef; value: string; onChange: (v: string) => void; onEnter: () => void }) {
  const style = { width: widthOf(filter) };
  const id = `report-filter-${filter.key}`;
  switch (filter.type) {
    case 'select':
      return (
        <Select
          id={id}
          style={style}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={t('report.filters.all')}
          aria-label={filter.label}
          value={value || undefined}
          onChange={(v: string | undefined) => onChange(v ?? '')}
          options={(filter.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
        />
      );
    case 'date':
      return <Input id={id} type="date" style={style} aria-label={filter.label} value={value} onChange={(e) => onChange(e.target.value)} onPressEnter={onEnter} />;
    case 'number':
      return <Input id={id} type="number" inputMode="decimal" style={style} aria-label={filter.label} value={value} onChange={(e) => onChange(e.target.value)} onPressEnter={onEnter} />;
    default:
      return <Input id={id} style={style} allowClear maxLength={MAX_TEXT_LENGTH} aria-label={filter.label} value={value} onChange={(e) => onChange(e.target.value)} onPressEnter={onEnter} />;
  }
}

/** Тайлангийн `definition.filters`-ээс динамикаар үүсэх шүүлтийн мөр. "Хайх" дарж байж URL/query шинэчлэгдэнэ (бичих бүрд сервер рүү хандахгүй). */
export function ReportFilters({ filters, values, busy, onApply, onReset }: Props) {
  const [draft, setDraft] = useState<FilterValues>(values);
  // Хэрэглэгдсэн шүүлт өөрчлөгдөхөд (цэвэрлэх, URL) draft-ыг синхрончилно. Агуулгаар харьцуулна — хуудас солиход draft алдагдахгүй.
  const serial = JSON.stringify(values);
  useEffect(() => {
    setDraft(JSON.parse(serial) as FilterValues);
  }, [serial]);

  const compact = compactFilters(draft, filters);
  const errorKey = validateFilters(compact);
  const hasSearch = filters.some((f) => f.key === 'search');
  const hasScopeFilter = filters.some((f) => f.key === 'branchId' || f.key === 'officerId');
  const apply = () => {
    if (!errorKey) onApply(compact);
  };

  return (
    <Flex vertical gap={8}>
      <Flex wrap gap={12} align="end">
        {filters.map((f) => (
          <Flex key={f.key} vertical gap={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}><label htmlFor={`report-filter-${f.key}`}>{f.label}</label></Typography.Text>
            <Control filter={f} value={draft[f.key] ?? ''} onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} onEnter={apply} />
          </Flex>
        ))}
        <Button type="primary" onClick={apply} disabled={Boolean(errorKey)} loading={busy}>{t('report.filters.apply')}</Button>
        <Button onClick={onReset} disabled={Object.keys(values).length === 0 && Object.keys(compact).length === 0}>{t('report.filters.reset')}</Button>
      </Flex>
      {errorKey ? <Typography.Text type="danger" role="alert">{t(errorKey)}</Typography.Text> : null}
      {hasSearch ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('report.filters.searchHint')}</Typography.Text> : null}
      {hasScopeFilter ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('report.filters.scopeHint')}</Typography.Text> : null}
    </Flex>
  );
}
