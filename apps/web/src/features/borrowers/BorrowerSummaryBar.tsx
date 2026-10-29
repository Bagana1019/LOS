'use client';
import { Card, Flex, Statistic, Typography, theme } from 'antd';
import type { BorrowerSummary } from '@los/contracts';
import { t } from '../../lib/i18n';
import { coverageBelowLoan, formatPercent } from './borrowers.utils';

interface TileProps {
  title: string;
  value: string;
  hint?: string;
  danger?: boolean;
}

function Tile({ title, value, hint, danger }: TileProps) {
  const { token } = theme.useToken();
  return (
    <Card size="small" style={{ flex: '1 1 160px', minWidth: 160 }}>
      <Statistic title={title} value={value} valueStyle={{ fontSize: 20, ...(danger ? { color: token.colorError } : {}) }} />
      {hint ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint}</Typography.Text> : null}
    </Card>
  );
}

/** Хураангуй: дүр бүрийн тоо (хязгаартай), үндсэний үлдэгдэл хариуцлага, баталгааны хамрах хувь. */
export function BorrowerSummaryBar({ summary }: { summary: BorrowerSummary }) {
  const empty = t('borrower.common.empty');
  const ofMax = (count: number, max: number) => t('borrower.summary.countOfMax', { count, max });
  return (
    <Flex gap={12} wrap>
      <Tile title={t('borrower.summary.primary')} value={String(summary.primaryCount)} />
      <Tile title={t('borrower.summary.coBorrower')} value={ofMax(summary.coBorrowerCount, summary.limits.maxCoBorrowers)} />
      <Tile title={t('borrower.summary.guarantor')} value={ofMax(summary.guarantorCount, summary.limits.maxGuarantors)} />
      <Tile title={t('borrower.summary.pledgor')} value={String(summary.pledgorCount)} />
      <Tile
        title={t('borrower.summary.primaryShare')}
        value={summary.primaryLiabilityShare === null ? empty : formatPercent(summary.primaryLiabilityShare)}
        hint={t('borrower.summary.primaryShareHint')}
      />
      <Tile
        title={t('borrower.summary.coverage')}
        value={summary.guaranteeCoverageRatio === null ? empty : formatPercent(summary.guaranteeCoverageRatio)}
        hint={t('borrower.summary.coverageHint')}
        danger={coverageBelowLoan(summary.guaranteeCoverageRatio)}
      />
    </Flex>
  );
}
