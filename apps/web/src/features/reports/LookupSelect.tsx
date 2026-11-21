'use client';
import { Select, Typography } from 'antd';
import { t } from '../../lib/i18n';
import type { LookupKind, LookupOption, LookupStatus } from './report-lookups';

const NOT_FOUND_KEY: Record<LookupKind, string> = {
  branch: 'report.lookup.branch.notFound',
  officer: 'report.lookup.officer.notFound',
  product: 'report.lookup.product.notFound',
};

interface Props {
  id: string;
  /** Хандалтын нэр (шошготой ижил). */
  label: string;
  kind: LookupKind;
  value: string;
  /** Одоогийн утгыг агуулсан сонголт (`selectModel`). */
  options: readonly LookupOption[];
  /** Одоогийн утга лавлахад олдоогүй: түүхий утгыг үзүүлж, сануулга гаргана. */
  notFound: boolean;
  status: LookupStatus;
  width: number;
  onChange: (value: string) => void;
}

/**
 * F11-1: салбар / ЗЭЗ / бүтээгдэхүүний шүүлт — нэрээр хайдаг Select, утга нь id (API параметр өөрчлөгдөхгүй).
 * Чөлөөт текст байхгүй: танихгүй id-г чимээгүй зөвшөөрөхгүй, нэр бичээд "олдсонгүй" хоосон дэлгэц авахгүй.
 */
export function LookupSelect({ id, label, kind, value, options, notFound, status, width, onChange }: Props) {
  return (
    <>
      <Select
        id={id}
        style={{ width }}
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder={t('report.filters.all')}
        notFoundContent={t('report.lookup.noOptions')}
        aria-label={label}
        loading={status === 'loading'}
        status={notFound || status === 'failed' ? 'warning' : undefined}
        value={value || undefined}
        onChange={(v: string | undefined) => onChange(v ?? '')}
        options={options.map((o) => ({ value: o.value, label: o.label }))}
      />
      {notFound ? <Typography.Text type="warning" role="status" style={{ fontSize: 12, maxWidth: width }}>{t(NOT_FOUND_KEY[kind])}</Typography.Text> : null}
      {status === 'failed' ? <Typography.Text type="danger" role="status" style={{ fontSize: 12, maxWidth: width }}>{t('report.lookup.loadFailed')}</Typography.Text> : null}
    </>
  );
}
