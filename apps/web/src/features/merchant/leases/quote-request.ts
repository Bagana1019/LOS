import type { GoodsCategory, PosQuoteRequest } from '@los/contracts';
import type { z } from 'zod';

export interface QuoteFormValues {
  planCode?: string;
  category?: GoodsCategory;
  price?: number | null;
  downPayment?: number | null;
  termMonths?: number;
}
export type QuoteRequestInput = z.input<typeof PosQuoteRequest>;

/** Формоос quote хүсэлт. Бүрэн, ойлгомжтой оролттой үед л (энгийн шалгалт — бизнес дүрмийг сервер шалгана). */
export function buildQuoteRequest(v: QuoteFormValues): QuoteRequestInput | null {
  if (!v.planCode || !v.termMonths) return null;
  if (typeof v.price !== 'number' || !(v.price > 0)) return null;
  if (typeof v.downPayment !== 'number' || v.downPayment < 0 || v.downPayment >= v.price) return null;
  return { planCode: v.planCode, goodsPrice: v.price, downPayment: v.downPayment, termMonths: v.termMonths, ...(v.category ? { goodsCategory: v.category } : {}) };
}

/** Урьдчилгааны товчлол: оруулсан үнийн N% (бүхэл төгрөгт бөөрөнхийлсөн). Оролтын тусламж, санхүүгийн тооцоолол биш — сервер дахин шалгана. */
export function downPaymentShortcut(price: number, percent: number): number {
  return Math.round((price * percent) / 100);
}
