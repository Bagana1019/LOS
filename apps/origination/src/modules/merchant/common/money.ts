// Мөнгө number (MNT, 2 орон). Нийлбэрийг бүхэл centээр бодож float алдаа (0.1+0.2) гаргахгүй.
export const toCents = (amount: number) => Math.round(amount * 100);
export const fromCents = (cents: number) => cents / 100;
export const roundMoney = (amount: number) => fromCents(toCents(amount));
export const sumMoney = (amounts: Iterable<number>) => fromCents([...amounts].reduce((s, a) => s + toCents(a), 0));
/** ceil(rate × price) — float шуугианыг (0.2 × 1_000_000 = 200000.00000000003) 6 оронд тойруулж арилгана. */
export const ceilRateOf = (rate: number, price: number) => Math.ceil(Math.round(rate * price * 1e6) / 1e6);
