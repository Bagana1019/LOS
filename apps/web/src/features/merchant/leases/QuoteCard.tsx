'use client';
import type { PosQuote } from '@los/contracts';
import { Skeleton } from 'antd';
import { formatMnt } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { errorMessage } from '../errors';
import { QuoteBreakdown } from './QuoteBreakdown';

interface Props {
  quote: PosQuote | undefined;
  error: unknown;
  /** Оролт өөрчлөгдсөн, шинэ quote ирээгүй (debounce / fetching). */
  pending: boolean;
  /** Хүсэлт бүрдээгүй. */
  idle: boolean;
}

/** Амьд quote карт: сарын төлбөрийг тодоор. Мэдээлэл `aria-live`-аар зарлагдана. */
export function QuoteCard({ quote, error, pending, idle }: Props) {
  const showError = !!error && !pending && !idle;
  return (
    <section className="mp-quote-card" aria-labelledby="quote-h" data-testid="quote-card">
      <h2 id="quote-h" className="mp-quote-title">{t('quote.title')}</h2>
      <div aria-live="polite" aria-atomic="true">
        {idle ? (
          <p className="mp-quote-idle">{t('quote.idle')}</p>
        ) : showError ? (
          <p className="mp-quote-error" role="alert">{errorMessage(error)}</p>
        ) : quote ? (
          <div className={pending ? 'mp-quote-stale' : undefined}>
            <div className="mp-quote-main">
              <span className="mp-quote-label">{t('quote.monthly')}</span>
              <span className="mp-quote-amount" data-testid="quote-monthly">{formatMnt(quote.monthlyPayment)}</span>
              <span className="mp-quote-term">{t('quote.perMonth', { term: quote.termMonths })}</span>
            </div>
            {pending ? <p className="mp-quote-updating">{t('quote.updating')}</p> : null}
          </div>
        ) : (
          <div aria-busy="true"><Skeleton active title={{ width: '50%' }} paragraph={{ rows: 2 }} /></div>
        )}
      </div>
      {quote && !idle && !showError ? <QuoteBreakdown quote={quote} /> : null}
    </section>
  );
}
