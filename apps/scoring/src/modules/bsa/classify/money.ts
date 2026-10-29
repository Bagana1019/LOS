// Мөнгөн дүнг бүхэл "минор нэгж" (1/100) болгож float drift-гүй харьцуулж нэмнэ. Шинэ dependency (decimal.js) нэмэхгүй.
// Ангилагч, own-transfer, other-share, aggregate нийтээр ашиглана.

/**
 * Дүнг бүхэл минор нэгж (×100) болгоно. Хуулгын дүн ≤ 2 аравтын оронтой тул Math.round яг зөв (float → хамгийн ойр бүхэл);
 * 2-оос олон оронтой бол ойролцоо бөөрөнхийлнө. Төгсгөлгүй, аюулгүй бүхэл хэмжээнээс том дүн → RangeError.
 */
export function toMinor(amount: number): number {
  const minor = Math.round(Math.abs(amount) * 100) * (amount < 0 ? -1 : 1);
  if (!Number.isSafeInteger(minor)) throw new RangeError('amount must be a finite number of reasonable size');
  return minor + 0; // -0 → 0
}

/** `toMinor`-той адил, гэхдээ тоо биш/хэт том дүнд шидэхгүй null буцаана (нэг муу мөр бүх ангиллыг унагахгүйн тулд) */
export function toMinorOrNull(amount: number): number | null {
  if (typeof amount !== 'number') return null;
  const minor = Math.round(Math.abs(amount) * 100);
  return Number.isSafeInteger(minor) ? Math.sign(amount) * minor + 0 : null;
}

/** Бүхэл минор нэгжээс 2 оронтой тоо руу (нэг хуваалт тул хамгийн ойр double) */
export function fromMinor(minor: number | bigint): number {
  return Number(minor) / 100;
}

/** BigInt-ээр нийлбэр: олон гүйлгээний нийлбэр Number.MAX_SAFE_INTEGER-ээс давахгүй байх баталгаагүй */
export class MinorSum {
  private total = 0n;
  add(minor: number): void {
    this.total += BigInt(minor);
  }
  get value(): bigint {
    return this.total;
  }
  get amount(): number {
    return fromMinor(this.total);
  }
}
