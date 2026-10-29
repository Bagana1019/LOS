// FR-14.2, FR-14.4
export const collateralValue = (marketValue: number, haircut: number) => Math.round(marketValue * haircut * 100) / 100;
export const ltv = (loanAmount: number, totalCollateralValue: number) => totalCollateralValue <= 0 ? Infinity : loanAmount / totalCollateralValue;

/** Үнэлэгдсэн барьцааны үнэлгээний нийлбэр (FR-14.4): null/NaN/сөрөг утгыг тооцохгүй. 2 орноор бөөрөнхийлнө. */
export const totalCollateralValue = (values: readonly (number | null | undefined)[]): number =>
  Math.round(values.reduce<number>((sum, v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? sum + v : sum), 0) * 100) / 100;

export interface LtvCheck {
  /** LTV (бутархай). Зээлийн дүн мэдэгдэхгүй, эсвэл барьцааны үнэлгээ 0 үед `null` (JSON-д Infinity гарахгүй). */
  ltv: number | null;
  limit: number;
  /** `null` = шалгах боломжгүй (зээлийн дүн алга). Барьцааны үнэлгээ 0 ба зээл > 0 бол `false`. */
  pass: boolean | null;
  totalCollateralValue: number;
}

/** FR-14.4 · LTV = зээл ÷ Σ барьцааны үнэлгээ; LTV ≤ дээд хязгаар бол хангана (AC: 50,000,000 / 21,000,000 > 70% → хангахгүй). */
export function checkLtv(loanAmount: number | null | undefined, collateralValues: readonly (number | null | undefined)[], limit: number): LtvCheck {
  const total = totalCollateralValue(collateralValues);
  if (typeof loanAmount !== 'number' || !Number.isFinite(loanAmount) || loanAmount < 0) return { ltv: null, limit, pass: null, totalCollateralValue: total };
  if (total <= 0) return { ltv: null, limit, pass: loanAmount === 0, totalCollateralValue: total };
  const ratio = ltv(loanAmount, total);
  return { ltv: ratio, limit, pass: ratio <= limit, totalCollateralValue: total };
}
