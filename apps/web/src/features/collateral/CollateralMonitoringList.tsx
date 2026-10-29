'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Empty, Flex, InputNumber, List, Skeleton, Tag, Typography } from 'antd';
import { EMPTY_VALUE, formatPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { ApiErrorAlert } from '../documents/shared/ApiErrorAlert';
import { assetTypeKey, stepHref } from './collateral.utils';
import { useCollateralMonitoring } from './useCollateral';

interface Props {
  /** Хэдэн хоногийн дотор хугацаа дуусах / дахин үнэлэх ёстойг харуулах (анхдагч 30). */
  defaultWithinDays?: number;
}

const REASON_COLOR = { REVALUATION_DUE: 'warning', INSURANCE_EXPIRING: 'warning', INSURANCE_EXPIRED: 'error', LTV_BREACH: 'error' } as const;

/**
 * FR-6.9, FR-14.6: идэвхтэй зээлийн барьцааны мониторинг — дахин үнэлэх, даатгал дуусах, LTV хэтэрсөн. Хүсэлтээс үл хамаарна (`GET /collaterals/monitoring`).
 * Энэ бүрэлдэхүүнд route, цэс нэмээгүй — тайлан/хяналтын самбарт нэмэхэд бэлэн экспорт.
 */
export function CollateralMonitoringList({ defaultWithinDays = 30 }: Props) {
  const [days, setDays] = useState(defaultWithinDays);
  const q = useCollateralMonitoring(days);
  return (
    <Flex vertical gap={12} data-testid="collateral-monitoring">
      <Flex align="center" gap={8} wrap>
        <label htmlFor="collateral-monitoring-days">{t('collateral.monitoring.withinDays')}</label>
        <InputNumber id="collateral-monitoring-days" min={0} max={3650} precision={0} value={days} onChange={(v) => setDays(typeof v === 'number' ? v : defaultWithinDays)} />
      </Flex>
      {q.isPending ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : q.isError ? (
        <ApiErrorAlert error={q.error} scope="collateral" onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('collateral.monitoring.empty')} />
      ) : (
        <List
          bordered
          dataSource={q.data.items}
          renderItem={(i) => (
            <List.Item key={`${i.collateralId}`}>
              <Flex vertical gap={4} style={{ width: '100%' }}>
                <Flex gap={8} align="center" wrap>
                  <Link href={stepHref(i.applicationId, 'collateral')}>{i.appNo}</Link>
                  <Tag color="blue" style={{ marginInlineEnd: 0 }}>{t(assetTypeKey(i.assetType))}</Tag>
                  <Typography.Text>{i.label}</Typography.Text>
                </Flex>
                <Flex gap={6} wrap>
                  {i.reasons.map((r) => (
                    <Tag key={r} color={REASON_COLOR[r]} style={{ marginInlineEnd: 0 }}>{t(`collateral.monitoring.reason.${r}`)}</Tag>
                  ))}
                </Flex>
                <Typography.Text type="secondary">
                  {t('collateral.monitoring.nextRevaluation')}: {i.nextRevaluationAt ?? EMPTY_VALUE} · {t('collateral.monitoring.insurance')}: {i.insuranceExpiresAt ?? EMPTY_VALUE} · {t('collateral.monitoring.ltv')}: {i.ltv === null ? EMPTY_VALUE : formatPercent(i.ltv)} / {formatPercent(i.ltvLimit)}
                </Typography.Text>
              </Flex>
            </List.Item>
          )}
        />
      )}
    </Flex>
  );
}
