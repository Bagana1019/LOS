'use client';
import { Card, Descriptions, Flex, Typography } from 'antd';
import type { CollateralVerdict } from '@los/contracts';
import { t } from '../../lib/i18n';
import { EMPTY_VALUE } from '../../lib/format';
import { ReasonList } from './ReasonList';
import { VerdictTag } from './VerdictTag';
import { collateralTone, formatMoney, formatShare, formatUpperPercent } from './score.utils';

interface Props {
  applicationId: string;
  collateral: CollateralVerdict;
  dim: boolean;
}

/** FR-8.4 / BR-3: LTV ≤ хязгаар. Барьцаа шаардахгүй ба хөрөнгөгүй бол «Хамаарахгүй» (саарал). */
export function CollateralCard({ applicationId, collateral: c, dim }: Props) {
  const tone = collateralTone(c);
  const notApplicable = tone === 'na';
  return (
    <Card
      title={t('score.collateral.title')}
      size="small"
      extra={<VerdictTag tone={tone} />}
      role="region"
      aria-label={t('score.collateral.title')}
      style={{ height: '100%', opacity: dim ? 0.55 : 1, transition: 'opacity .15s' }}
      aria-busy={dim}
    >
      <Flex vertical gap={12}>
        {notApplicable ? <Typography.Text type="secondary">{t('score.collateral.notApplicable')}</Typography.Text> : null}
        <Descriptions
          size="small"
          column={1}
          colon={false}
          items={[
            { key: 'required', label: t('score.collateral.required'), children: t(c.required ? 'score.collateral.required.yes' : 'score.collateral.required.no') },
            { key: 'valueTotal', label: t('score.collateral.valueTotal'), children: formatMoney(c.valueTotal) },
            {
              key: 'ltv',
              label: t('score.collateral.ltv'),
              children: (
                <span data-cell="ltv">
                  {formatUpperPercent(c.ltv)} <Typography.Text type="secondary">({t('score.compare.limit', { sign: '≤', value: formatShare(c.limit) })})</Typography.Text>
                </span>
              ),
            },
            { key: 'maxAmount', label: t('score.collateral.maxAmount'), children: c.maxAmount === null ? (c.required ? EMPTY_VALUE : t('score.collateral.unlimited')) : formatMoney(c.maxAmount) },
          ]}
        />
        {c.reasons.length > 0 ? <ReasonList applicationId={applicationId} reasons={c.reasons} /> : null}
      </Flex>
    </Card>
  );
}
