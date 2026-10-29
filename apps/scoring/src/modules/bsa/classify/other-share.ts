// BSA-BR-7 / BSA-FR-3.6: "Бусад" ('?' бүлгийн) ангиллын дүнгийн хувь босгоос давбал анхааруулж гар ангилал шаардана.
// Чиглэл тус бүрээр (орлого, зарлага) тусад нь. Өөрийн данс хоорондын шилжүүлэг ба EXCLUDE үүрэгтэй ангилал (хадгаламж гэх мэт) хуваарь,
// хуваагчид ОРОХГҮЙ — тэд DTI-д оролцдоггүй (calc-ын share-ийн суурьтай нэг). Үл мэдэгдэх ангиллын код = ангилагдаагүй гэж "Бусад"-д тооцогдоно.
import type { TxnDirection } from '@los/contracts';
import { OTHER_GROUP_CODE } from './classify.defaults';
import type { BsaCategoryDef, ClassifiedTxn, OtherShareReport } from './classify.types';
import { fromMinor, MinorSum, toMinorOrNull } from './money';

/** Босгыг бүхэл (ppm) болгож BigInt-ээр харьцуулна: 0.3 × 100 = 30.000000000000004 шиг float алдаа "яг босго = давсангүй" дүрмийг эвдэхгүй */
const PPM = 1_000_000;

const DIRECTIONS: readonly TxnDirection[] = ['INCOME', 'EXPENSE'];

export function computeOtherShare(
  classified: readonly ClassifiedTxn[],
  categories: readonly BsaCategoryDef[],
  threshold: number,
): OtherShareReport[] {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new RangeError(`threshold must be within 0..1, got ${threshold}`);
  const thresholdPpm = BigInt(Math.round(threshold * PPM));
  const byCode = new Map(categories.map((c) => [c.code, c]));
  const sums = new Map<TxnDirection, { total: MinorSum; other: MinorSum }>(DIRECTIONS.map((d) => [d, { total: new MinorSum(), other: new MinorSum() }]));

  for (const { txn, result } of classified) {
    if (result.isOwnTransfer) continue;
    const minor = toMinorOrNull(txn.amount);
    if (minor === null || minor <= 0) continue;
    const category = byCode.get(result.categoryCode);
    if (category?.dtiRole === 'EXCLUDE') continue;
    const bucket = sums.get(txn.direction);
    if (!bucket) continue;
    bucket.total.add(minor);
    if (!category || category.groupCode === OTHER_GROUP_CODE) bucket.other.add(minor);
  }

  return DIRECTIONS.map((direction): OtherShareReport => {
    const { total, other } = sums.get(direction) as { total: MinorSum; other: MinorSum };
    const hasTotal = total.value > 0n;
    return {
      direction,
      otherAmount: fromMinor(other.value),
      totalAmount: fromMinor(total.value),
      share: hasTotal ? Math.round((Number(other.value) / Number(total.value)) * PPM) / PPM : 0,
      exceeded: hasTotal && other.value * BigInt(PPM) > thresholdPpm * total.value,
    };
  });
}
