'use client';
import { Typography, theme } from 'antd';
import type { UnderwriteResult, CalcMethod } from '@los/contracts';
import { t } from '../../lib/i18n';
import { formatMoney, referenceMethod } from './score.utils';

interface Props {
  result: UnderwriteResult | null;
  /** Сонгосон арга (байвал) — нийт өрийн үйлчилгээг тэр аргаас авна (гурван аргад ижил). */
  selected: CalcMethod | null;
  pending: boolean;
}

/** FR-8.3: сарын төлбөр, нийт өрийн үйлчилгээ, хүүгийн орлого — бүгд серверийн хариунаас. aria-live: утга шинэчлэгдэхэд уншина. */
export function LiveNumbers({ result, selected, pending }: Props) {
  const { token } = theme.useToken();
  const cells: Array<{ id: string; label: string; value: string }> = result
    ? [
        { id: 'monthlyPayment', label: t('score.live.monthlyPayment'), value: formatMoney(result.loan.monthlyPayment) },
        { id: 'totalDebtService', label: t('score.live.totalDebtService'), value: formatMoney(referenceMethod(result, selected).totalDebtService) },
        { id: 'totalInterest', label: t('score.live.totalInterest'), value: formatMoney(result.loan.totalInterest) },
      ]
    : [];
  return (
    <div aria-live="polite" aria-busy={pending} data-testid="score-live">
      {result ? (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, opacity: pending ? 0.55 : 1, transition: 'opacity .15s' }}>
          {cells.map((c) => (
            <div key={c.id} data-live={c.id}>
              <dt style={{ color: token.colorTextSecondary }}>{c.label}</dt>
              <dd style={{ margin: 0, fontSize: 20, fontWeight: 600, overflowWrap: 'anywhere' }}>{c.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <Typography.Text type="secondary">{pending ? t('score.live.pending') : t('score.live.unavailable')}</Typography.Text>
      )}
    </div>
  );
}
