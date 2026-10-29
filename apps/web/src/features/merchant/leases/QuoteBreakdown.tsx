import type { PosQuote } from '@los/contracts';
import { formatMnt, formatPercent } from '../../../lib/format';
import { t } from '../../../lib/i18n';

interface Props {
  quote: PosQuote;
  /** Мерчантын шимтгэл, цэвэр дүнг харуулах эсэх. */
  showMerchant?: boolean;
  heading?: boolean;
}

/** Серверийн PosQuote-ыг зөвхөн форматлан харуулна (UI-д тооцоолол байхгүй). */
export function QuoteBreakdown({ quote, showMerchant = true, heading = true }: Props) {
  const rows: Array<[string, string, string?]> = [
    [t('quote.goodsPrice'), formatMnt(quote.goodsPrice)],
    [t('quote.downPayment'), formatMnt(quote.downPayment), formatPercent(quote.downPaymentRate, 1)],
    [t('quote.financed'), formatMnt(quote.financedAmount)],
    [t('quote.fee'), formatMnt(quote.feeAmount), formatPercent(quote.feeRate, 2)],
    [t('quote.principal'), formatMnt(quote.principal)],
    [t('quote.annualRate'), formatPercent(quote.annualRate, 2)],
    [t('quote.effectiveRate'), formatPercent(quote.effectiveAnnualRate, 2)],
    [t('quote.totalRepayment'), formatMnt(quote.totalRepayment)],
    [t('quote.totalInterestAndFees'), formatMnt(quote.totalInterestAndFees)],
    [t('quote.totalCost'), formatMnt(quote.totalCostToBuyer)],
  ];
  return (
    <div className="mp-quote-breakdown">
      {heading ? <h3 className="mp-subtitle">{t('quote.breakdown')}</h3> : null}
      <dl className="mp-dl">
        {rows.map(([label, value, note]) => (
          <div key={label} className="mp-dl-row">
            <dt>{label}</dt>
            <dd><span className="mp-nowrap">{value}</span>{note ? <span className="mp-dl-note"> · {note}</span> : null}</dd>
          </div>
        ))}
      </dl>
      {showMerchant ? (
        <dl className="mp-dl mp-dl-merchant">
          <div className="mp-dl-row"><dt>{t('quote.commission')}</dt><dd><span className="mp-nowrap">{formatMnt(quote.merchantCommissionAmount)}</span><span className="mp-dl-note"> · {formatPercent(quote.merchantCommissionRate, 2)}</span></dd></div>
          <div className="mp-dl-row mp-dl-strong"><dt>{t('quote.merchantNet')}</dt><dd><span className="mp-nowrap">{formatMnt(quote.merchantNetAmount)}</span></dd></div>
        </dl>
      ) : null}
    </div>
  );
}
