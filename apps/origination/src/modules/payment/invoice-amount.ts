import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '.prisma/client-origination';
import { outstandingOf, payNowAmount, type AllocatableInstallment } from '@los/calc';

// decimal.js нь origination-ы шууд dependency биш — Prisma-гийн Decimal (decimal.js) ашиглана.
const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

const fmt = (n: Decimal | number) => new Decimal(n).toDecimalPlaces(2).toFixed(2).replace(/\.00$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const outOfRange = (message: string) => new HttpException({ code: 'AMOUNT_OUT_OF_RANGE', message }, 422);

export interface ResolveAmountInput { installments: AllocatableInstallment[]; scheduleRowId?: string; amount?: number; minAmount: number; asOf: string }

/**
 * Брифийн бизнес дүрэм 1: invoice-ийн дүн.
 *  · scheduleRowId өгвөл тэр мөрийн үлдэгдэл (хэсэгчлэн төлсөн бол үлдэгдэл; бүрэн төлөгдсөн бол 409 INSTALLMENT_PAID); amount ≤ мөрийн үлдэгдэл.
 *  · өгөөгүй бол amount; тэр ч үгүй бол payNowAmount.
 *  · хязгаар: min(payment.min_amount, боломжит дээд) ≤ дүн ≤ нийт үлдэгдэл (422 AMOUNT_OUT_OF_RANGE); үлдэгдэл 0 бол 409.
 * Доод хязгаарыг боломжит дээд дүнгээр "дарж" өгдөг — min_amount-аас бага үлдэгдэл (жишээ нь 500₮) нь өөрөө бүрэн төлөгдөх боломжтой байх ёстой.
 * Мөн дүн/мөр заагаагүй ("Одоо төлөх") замд дүнг өөрөө (payNowAmount) бодсон тул доод хязгаар нь тэр дүнээс хэтрэхгүй:
 * хугацаа болсон жижиг үлдэгдэл (жишээ нь 300₮ < min_amount) UI-д "Одоо төлөх" гэж харагддаг тул яг тэр дүнгээр төлөгдөх ёстой.
 * Хэрэглэгчийн ӨӨРИЙН заасан дүнд (мөргүй) min_amount хэвээр үйлчилнэ.
 */
export function resolveInvoiceAmount(input: ResolveAmountInput): number {
  const total = input.installments.reduce((s, i) => s.plus(outstandingOf(i)), new Decimal(0));
  let ceiling = total;
  let candidate: Decimal;
  if (input.scheduleRowId) {
    const row = input.installments.find((i) => i.id === input.scheduleRowId);
    if (!row) throw new NotFoundException({ code: 'SCHEDULE_ROW_NOT_FOUND', message: 'Эргэн төлөлтийн хуваарийн мөр олдсонгүй' });
    const rowOutstanding = new Decimal(outstandingOf(row));
    if (rowOutstanding.lte(0)) throw new ConflictException({ code: 'INSTALLMENT_PAID', message: 'Энэ мөрийн төлбөр бүрэн төлөгдсөн байна' });
    ceiling = rowOutstanding;
    candidate = input.amount !== undefined ? new Decimal(input.amount) : rowOutstanding;
  } else {
    if (total.lte(0)) throw new ConflictException({ code: 'LOAN_FULLY_PAID', message: 'Зээлийн үлдэгдэл байхгүй, төлөх дүн алга' });
    candidate = input.amount !== undefined ? new Decimal(input.amount) : new Decimal(payNowAmount(input.installments, input.asOf));
  }
  candidate = candidate.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  let floor = Decimal.min(input.minAmount, ceiling);
  if (!input.scheduleRowId && input.amount === undefined && candidate.gt(0)) floor = Decimal.min(floor, candidate);
  if (candidate.lt(floor) || candidate.gt(ceiling)) {
    throw outOfRange(`Төлөх дүн ${fmt(floor)}-аас ${fmt(ceiling)} хооронд байх ёстой (оруулсан: ${fmt(candidate)})`);
  }
  return candidate.toNumber();
}
