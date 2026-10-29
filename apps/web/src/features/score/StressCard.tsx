'use client';
import { Card, Descriptions, Flex, Typography } from 'antd';
import type { UnderwriteResult } from '@los/contracts';
import { t } from '../../lib/i18n';
import { formatMoney, formatSignedPercent } from './score.utils';

interface Props {
  stress: UnderwriteResult['stress'];
  dim: boolean;
}

/** FR-8.5: stress сценарийн нөхцөл (хүү өсөх, орлого буурах). Аргуудын дүнгийн мөр харьцуулах хүснэгтэд. Мэдээллийн шинжтэй (Q-M8-9). */
export function StressCard({ stress, dim }: Props) {
  return (
    <Card title={t('score.stress.title')} size="small" role="region" aria-label={t('score.stress.title')} style={{ height: '100%', opacity: dim ? 0.55 : 1, transition: 'opacity .15s' }} aria-busy={dim}>
      {stress ? (
        <Flex vertical gap={12}>
          <Descriptions
            size="small"
            column={1}
            colon={false}
            items={[
              { key: 'rate', label: t('score.stress.rate'), children: t('score.stress.rateValue', { points: stress.rateDeltaPoints }) },
              { key: 'income', label: t('score.stress.income'), children: formatSignedPercent(stress.incomeChange) },
              { key: 'payment', label: t('score.stress.payment'), children: formatMoney(stress.stressedMonthlyPayment) },
            ]}
          />
          <Typography.Text type="secondary">{t('score.stress.note')}</Typography.Text>
        </Flex>
      ) : (
        <Typography.Text type="secondary">{t('score.stress.none')}</Typography.Text>
      )}
    </Card>
  );
}
