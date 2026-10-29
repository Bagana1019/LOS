import { GoodsCategory, type PosLeaseView } from '@los/contracts';
// DECLINED → "Урьдчилгааг X₮ болгож дахин оролдох": шинэ лизингийн формыг өмнөх утгаар бөглөх. Худалдан авагчийн регистр/утас URL-д ЭСВЭЛ хадгалалтад орохгүй (PII) — санах ойн retry-draft.ts.

export interface LeasePrefill {
  retryOf?: string;
  planCode?: string;
  category?: GoodsCategory;
  goodsName?: string;
  price?: number;
  downPayment?: number;
  termMonths?: number;
}

const num = (v: string | null): number | undefined => {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

export function parsePrefill(sp: URLSearchParams): LeasePrefill {
  const category = sp.get('category');
  const term = num(sp.get('term'));
  const goods = (sp.get('goods') ?? '').slice(0, 200);
  return {
    ...(sp.get('retryOf') ? { retryOf: sp.get('retryOf') as string } : {}),
    ...(sp.get('planCode') ? { planCode: (sp.get('planCode') as string).toUpperCase() } : {}),
    ...(category && (GoodsCategory as readonly string[]).includes(category) ? { category: category as GoodsCategory } : {}),
    ...(goods ? { goodsName: goods } : {}),
    ...(num(sp.get('price')) !== undefined ? { price: num(sp.get('price')) } : {}),
    ...(num(sp.get('down')) !== undefined ? { downPayment: num(sp.get('down')) } : {}),
    ...(term !== undefined && Number.isInteger(term) && term > 0 ? { termMonths: term } : {}),
  };
}

/** Лизингээс шинэ формын холбоос; `downPayment` өгөгдвөл (санал болгосон урьдчилгаа) түүгээр бөглөнө. */
export function buildRetryHref(lease: Pick<PosLeaseView, 'id' | 'planCode' | 'goods' | 'quote'>, downPayment?: number | null): string {
  const sp = new URLSearchParams();
  sp.set('retryOf', lease.id);
  sp.set('planCode', lease.planCode);
  sp.set('category', lease.goods.category);
  sp.set('goods', lease.goods.name);
  sp.set('price', String(lease.goods.price));
  sp.set('term', String(lease.quote.termMonths));
  sp.set('down', String(downPayment ?? lease.quote.downPayment));
  return `/merchant/leases/new?${sp.toString()}`;
}
