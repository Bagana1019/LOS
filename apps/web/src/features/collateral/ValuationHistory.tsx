'use client';
import { App as AntApp, Button, Empty, Flex, List, Skeleton, Tag, Typography } from 'antd';
import type { CollateralValuationRecord } from '@los/contracts';
import { EMPTY_VALUE, formatDate, formatDateTime, formatMnt, formatPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { describeApiError } from '../documents/shared/api-error';
import { ApiErrorAlert } from '../documents/shared/ApiErrorAlert';
import { downloadDmsFile } from '../documents/shared/files';
import type { TabProps } from './TabProps';
import { useValuationHistory } from './useCollateral';

/** FR-14.3: үнэлгээний түүх (шинэ нь эхэнд): эх сурвалж, арга, зах зээлийн үнэ → haircut → барьцааны үнэлгээ, өөрчилсөн шалтгаан, гадны тайлан. */
export function ValuationHistory({ applicationId, item }: Pick<TabProps, 'applicationId' | 'item'>) {
  const { message } = AntApp.useApp();
  const q = useValuationHistory(applicationId, item.id, true);
  if (q.isPending) return <Skeleton active paragraph={{ rows: 3 }} />;
  if (q.isError) return <ApiErrorAlert error={q.error} scope="collateral" onRetry={() => void q.refetch()} />;
  if (q.data.items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('collateral.valuation.historyEmpty')} />;
  const download = (r: CollateralValuationRecord) => {
    if (r.reportFileId) downloadDmsFile(r.reportFileId, t('collateral.valuation.reportFileName')).catch((e: unknown) => void message.error(describeApiError(e, 'collateral').message));
  };
  return (
    <List
      size="small"
      dataSource={q.data.items}
      data-testid="valuation-history"
      renderItem={(r) => (
        <List.Item key={r.id}>
          <Flex vertical gap={4} style={{ width: '100%' }}>
            <Flex gap={8} align="center" wrap>
              <Typography.Text strong>{formatDateTime(r.valuedAt)}</Typography.Text>
              <Tag color={r.source === 'EXTERNAL_LICENSED' ? 'geekblue' : 'blue'} style={{ marginInlineEnd: 0 }}>{t(`collateral.valuationSource.${r.source}`)}</Tag>
              <Typography.Text type="secondary">{t(`collateral.valuationMethod.${r.method}`)}</Typography.Text>
              {r.haircutSource === 'DEMO_DEFAULT' ? <Tag color="purple" style={{ marginInlineEnd: 0 }}>{t('collateral.valuation.demoTag')}</Tag> : null}
            </Flex>
            <Typography.Text>
              {formatMnt(r.marketValue)} × {formatPercent(r.haircutRate)} = <Typography.Text strong>{formatMnt(r.collateralValue)}</Typography.Text>
            </Typography.Text>
            {r.suggestedValue !== null && r.suggestedValue !== r.marketValue ? (
              <Typography.Text type="secondary">{t('collateral.valuation.historySuggested', { value: formatMnt(r.suggestedValue) })}</Typography.Text>
            ) : null}
            {r.overrideReason ? <Typography.Text type="secondary">{t('collateral.valuation.historyReason', { reason: r.overrideReason })}</Typography.Text> : null}
            {r.appraiser ? (
              <Typography.Text type="secondary">
                {t('collateral.valuation.historyAppraiser', { name: r.appraiser })}
                {r.licenseNo ? ` (${r.licenseNo})` : ''}
              </Typography.Text>
            ) : null}
            <Flex gap={12} align="center" wrap>
              <Typography.Text type="secondary">{t('collateral.valuation.validUntil')}: {r.validUntil ? formatDate(r.validUntil) : EMPTY_VALUE}</Typography.Text>
              {r.reportFileId ? <Button size="small" type="link" onClick={() => download(r)}>{t('collateral.valuation.downloadReport')}</Button> : null}
            </Flex>
          </Flex>
        </List.Item>
      )}
    />
  );
}
