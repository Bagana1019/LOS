import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PricingQuoteResponse } from '@los/contracts';
import { API } from '../../lib/api';
import { textOfTestId, visibleText } from '../collateral/html.fixtures';
import { fetchRateQuote } from './loanTerms.api';
import { RateSuggestion } from './RateSuggestion';

// M11 · FR-5.5 / BR-14: "Хүү санал болгох" — хүүг яагаад санал болгосныг (шатлал, өнгө, Sosco Score / анхдагч, хязгаарт тайрсан) API-ийн утгаар харуулна; UI тооцоолохгүй.
const quote = (o: Partial<PricingQuoteResponse> = {}): PricingQuoteResponse => ({
  basis: 'SCORE', soscoScore: 700, tier: { code: 'B', name: 'Сайн', band: 'GREEN', minScore: 650 },
  tierInterestRate: 22, tierFeeRate: 0.01, interestRate: 22, feeRate: 0.01, rateBound: null, feeAmount: 300_000,
  productRateBounds: { minRate: 18, maxRate: 42 }, config: { scope: 'DEFAULT', productId: null, version: 1 }, ...o,
});
const render = (q: PricingQuoteResponse) => renderToString(<RateSuggestion quote={q} />);

describe('RateSuggestion', () => {
  it('Sosco Score-оор: шатлал, өнгө, оноо, санал болгосон хүү/шимтгэл', () => {
    const html = render(quote());
    const text = visibleText(html);
    expect(text).toContain('Сайн');
    expect(text).toContain('Бага эрсдэл');
    expect(text).toContain('Sosco Score-оор');
    expect(textOfTestId(html, 'rate-suggestion-score')).toContain('700');
    expect(textOfTestId(html, 'rate-suggestion-rate')).toContain('22%');
    expect(textOfTestId(html, 'rate-suggestion-fee')).toContain('1%');
    expect(text).not.toContain('хязгаарт тайрагдсан');
  });

  it('оноогүй бол анхдагч шатлал гэж тайлбарлана, оноо харуулахгүй', () => {
    const html = render(quote({ basis: 'DEFAULT_TIER', soscoScore: null, tier: { code: 'C', name: 'Дунд', band: 'YELLOW', minScore: 500 }, interestRate: 28, feeRate: 0.015 }));
    expect(visibleText(html)).toContain('Sosco Score байхгүй — анхдагч шатлал');
    expect(visibleText(html)).toContain('Дунд эрсдэл');
    expect(textOfTestId(html, 'rate-suggestion-score')).toBeNull();
    expect(textOfTestId(html, 'rate-suggestion-fee')).toContain('1.5%');
  });

  it('бүтээгдэхүүний хязгаарт тайрсан бол аль талаас нь заана (BR-6)', () => {
    expect(visibleText(render(quote({ tierInterestRate: 42, interestRate: 40, rateBound: 'MAX' })))).toContain('дээд хязгаарт тайрагдсан');
    expect(visibleText(render(quote({ tierInterestRate: 12, interestRate: 18, rateBound: 'MIN' })))).toContain('доод хязгаарт тайрагдсан');
  });
});

describe('fetchRateQuote', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;
  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify(quote()), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('байгаа quote endpoint-ийг (gateway `/origination` угтвартай) хүсэлтийн оноогоор дуудна', async () => {
    const res = await fetchRateQuote({ productId: 'p1', soscoScore: 700, amount: 30_000_000 });
    expect(res.interestRate).toBe(22);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/origination/loan-terms/pricing/quote`);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ productId: 'p1', soscoScore: 700, amount: 30_000_000 });
  });
});
