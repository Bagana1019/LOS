'use client';
import { Card, Flex, Statistic, Tag, Typography, theme } from 'antd';
import type { CollateralGate, CollateralSummary } from '@los/contracts';
import { EMPTY_VALUE, formatMnt, formatPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { gateState, ltvTone } from './collateral.utils';

interface TileProps {
  title: string;
  value: string;
  hint?: string;
  color?: string;
  testId?: string;
}

function Tile({ title, value, hint, color, testId }: TileProps) {
  return (
    <Card size="small" style={{ flex: '1 1 170px', minWidth: 150 }} data-testid={testId}>
      <Statistic title={title} value={value} valueStyle={{ fontSize: 20, ...(color ? { color } : {}) }} />
      {hint ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text> : null}
    </Card>
  );
}

interface Props {
  summary: CollateralSummary;
  gate: CollateralGate;
}

/**
 * Хураангуй (FR-14.4): нийт зах зээлийн үнэ, барьцааны үнэлгээ, зээлийн дүн, LTV хязгаартай харьцуулсан өнгөтэй, барьцаа шаардах эсэх, G0 төлөв.
 * Бүх тоо API-аас (`@los/calc` `checkLtv` серверт); UI зөвхөн форматлана.
 */
export function CollateralSummaryBar({ summary, gate }: Props) {
  const { token } = theme.useToken();
  const tone = ltvTone(summary);
  const ltvColor = tone === 'success' ? token.colorSuccess : tone === 'error' ? token.colorError : undefined;
  const state = gateState(gate);
  return (
    <Flex vertical gap={12}>
      <Flex gap={12} wrap>
        <Tile title={t('collateral.summary.marketValue')} value={formatMnt(summary.totalMarketValue)} testId="summary-market-value" />
        <Tile title={t('collateral.summary.collateralValue')} value={formatMnt(summary.totalCollateralValue)} hint={t('collateral.summary.collateralValueHint')} testId="summary-collateral-value" />
        <Tile
          title={t('collateral.summary.loanAmount')}
          value={summary.loanAmount === null ? EMPTY_VALUE : formatMnt(summary.loanAmount)}
          hint={summary.loanAmount === null ? t('collateral.summary.loanAmountMissing') : undefined}
          testId="summary-loan-amount"
        />
        <Tile
          title={t('collateral.summary.ltv')}
          value={summary.ltv === null ? EMPTY_VALUE : formatPercent(summary.ltv)}
          hint={t('collateral.summary.ltvLimit', { limit: formatPercent(summary.ltvLimit) })}
          color={ltvColor}
          testId="summary-ltv"
        />
      </Flex>
      <Flex gap={8} align="center" wrap>
        {summary.ltvPass === true ? <Tag color="success">{t('collateral.summary.ltvPass')}</Tag> : null}
        {summary.ltvPass === false ? <Tag color="error">{t('collateral.summary.ltvFail')}</Tag> : null}
        <Tag color={summary.requiresCollateral ? 'blue' : undefined}>{t(summary.requiresCollateral ? 'collateral.summary.required' : 'collateral.summary.notRequired')}</Tag>
        <Tag
          role="status"
          color={state === 'complete' ? 'success' : state === 'skipped' ? 'processing' : 'warning'}
          data-testid="gate-status"
        >
          {t(`collateral.gate.state.${state}`, { count: gate.issues.length })}
        </Tag>
        {!summary.requiresCollateral ? <Typography.Text type="secondary">{t('collateral.summary.notRequiredNote')}</Typography.Text> : null}
      </Flex>
    </Flex>
  );
}
