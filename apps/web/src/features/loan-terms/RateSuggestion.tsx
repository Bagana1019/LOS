'use client';
import { Alert, Flex, Tag, Typography } from 'antd';
import type { PricingQuoteResponse } from '@los/contracts';
import { formatPercent } from '../../lib/format';
import { t } from '../../lib/i18n';

const BAND_COLOR = { GREEN: 'success', YELLOW: 'warning', RED: 'error' } as const;

/** M11 · FR-5.5 / BR-14: санал болгосон хүүгийн шалтгаан — шатлал, эрсдэлийн өнгө, Sosco Score эсвэл анхдагч шатлал, BR-6 хязгаарт тайрсан эсэх. Утга бүр API-аас. */
export function RateSuggestion({ quote }: { quote: PricingQuoteResponse }) {
  return (
    <Alert
      type="info" showIcon data-testid="rate-suggestion"
      message={t('terms.suggest.title')}
      description={(
        <Flex vertical gap={4}>
          <Flex gap={8} wrap align="center">
            <Typography.Text>{t('terms.suggest.tier', { tier: quote.tier.name })}</Typography.Text>
            <Tag color={BAND_COLOR[quote.tier.band]}>{t(`pricing.band.${quote.tier.band}`)}</Tag>
            <Typography.Text type="secondary">{t(`pricing.basis.${quote.basis}`)}</Typography.Text>
            {quote.soscoScore != null ? <Typography.Text data-testid="rate-suggestion-score">{t('terms.suggest.score', { score: quote.soscoScore })}</Typography.Text> : null}
          </Flex>
          <Flex gap={16} wrap>
            <Typography.Text strong data-testid="rate-suggestion-rate">{t('terms.suggest.rate', { rate: `${quote.interestRate}%` })}</Typography.Text>
            <Typography.Text strong data-testid="rate-suggestion-fee">{t('terms.suggest.fee', { fee: formatPercent(quote.feeRate) })}</Typography.Text>
          </Flex>
          {quote.rateBound ? <Typography.Text type="warning">{t(`pricing.rateBound.${quote.rateBound}`)}</Typography.Text> : null}
          <Typography.Text type="secondary">{t('terms.suggest.override')}</Typography.Text>
        </Flex>
      )}
    />
  );
}
