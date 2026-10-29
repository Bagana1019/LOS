// BSA-ийн анхдагч ангилал ба дүрмийн сан (docs/02 §4). Persistence нэгж эндээс seed хийнэ (bsa_category, bsa_rule); admin дараа нь засна (NFR-6, BSA-FR-3.5).
//
// ТАНИЛЦУУЛГА:
//  - Дайчлах хувь (weight) нь docs/02 §4-ийн АНХДАГЧ; бодит утгыг admin тохируулна.
//  - Түлхүүр үгийг НЭГ удаа кирилл (эсвэл брэндийн латин) хэлбэрээр бичнэ — латин/кирилл/холимог хувилбарыг toMatchKey нэг түлхүүр болгоно.
//  - Түлхүүр үгийн сүүлийн үг (араг ясны) ≥ 4 тэмдэгт бол нөхцөл залгаж таарна ('цалин' → 'цалингийн'); богино үг ('ус', 'хүү', 'pos')
//    зөвхөн бүтэн үгээр таарна. Нөхцөлд үсэг нь өөрчлөгддөг үг ('эмнэлэг' → 'эмнэлгийн', 'тэтгэвэр' → 'тэтгэврийн') тусдаа мөр.
//  - Priority: WEAK 100 (ерөнхий үг) < NORMAL 200 < STRONG 300 (тодорхой хэллэг: буцаалт, зээлийн төлбөр, бооцоо). Тэнцвэл урт хэв ялна.
//  - Бүх дүрэм source = ADMIN (системийн суурь сан). Хэрэглэгчийн гар засвараас үүссэн дүрэм FEEDBACK, priority 500 (reclassify.ts).
// TODO(samples): бодит банкны хуулгын утга ирмэгц үг хэллэгийг баталгаажуулж өргөтгөнө — энэ жагсаалт нь шаардлагын баримт
//  (docs/02) ба ерөнхий монгол хэллэгт тулгуурласан таамаг; ЯМАР Ч банкны бодит формат/утгаар батлагдаагүй.
import type { TxnDirection } from '@los/contracts';
import { RULE_PRIORITY } from './classify.defaults';
import type { BsaCategoryDef, BsaRuleDef } from './classify.types';

const { WEAK, NORMAL, STRONG } = RULE_PRIORITY;

/** Бүлгийн код: тогтмол бус/хасагдах ангилалд docs/02 §4-ийн '—' */
const NONE = '—';

const income = (code: string, groupCode: string, name: string, weight: number, dtiRole: BsaCategoryDef['dtiRole'] = 'INCOME'): BsaCategoryDef => ({
  code, direction: 'INCOME', groupCode, name, weight, dtiRole, isActive: true,
});
const expense = (code: string, groupCode: string, name: string, dtiRole: BsaCategoryDef['dtiRole']): BsaCategoryDef => ({
  code, direction: 'EXPENSE', groupCode, name, weight: 1, dtiRole, isActive: true,
});

export const DEFAULT_BSA_CATEGORIES: BsaCategoryDef[] = [
  // ── Орлого (docs/02 §4) ──
  income('SALARY', 'A', 'Хөдөлмөрийн орлого (цалин)', 1),
  income('CASH_INCOME', 'B', 'Бэлэн орлого', 0.5),
  income('BUSINESS_INCOME', 'B', 'Бизнесийн орлого', 0.85),
  income('PASSIVE_INCOME', 'C', 'Идэвхгүй орлого (түрээс, хүү, ногдол ашиг)', 1),
  income('CONTRACT_INCOME', 'D', 'Гэрээт ажлын орлого', 0.7),
  income('OTHER_INCOME', '?', 'Бусад орлого', 0.1),
  income('IRREGULAR_INCOME', NONE, 'Тогтмол бус орлого', 0),
  income('LOAN_PROCEEDS', NONE, 'Зээл (авсан зээлийн олголт)', 0),
  income('NON_INCOME', NONE, 'Орлого бус (буцаалт, залруулга)', 0),
  income('ABNORMAL_INCOME', NONE, 'Хэвийн бус орлого', 0),
  income('SUSPICIOUS_INCOME', NONE, 'Сэжигтэй орлого', 0),
  // Өөрийн данс хоорондын шилжүүлэг (BSA-BR-5): DTI-д огт оролцохгүй
  income('OWN_TRANSFER_IN', NONE, 'Өөрийн данс хоорондын шилжүүлэг (орлого)', 0, 'EXCLUDE'),
  // ── Зарлага (docs/02 §4) ──
  expense('LOAN_PAYMENT', 'A', 'Зээлийн төлбөр', 'DEBT_SERVICE'),
  expense('DEBT_OBLIGATION', 'A', 'Өрийн үүрэг', 'DEBT_SERVICE'),
  expense('FIXED_EXPENSE', 'B', 'Тогтмол зардал', 'HOUSEHOLD'),
  expense('ESSENTIAL_EXPENSE', 'C', 'Зайлшгүй зардал', 'HOUSEHOLD'),
  expense('DISCRETIONARY_EXPENSE', 'D', 'Сонгон зардал', 'INFO'),
  expense('BUSINESS_EXPENSE', 'E', 'Бизнесийн зардал', 'BUSINESS_EXPENSE'),
  expense('BANK_FEE', 'F', 'Банкны шимтгэл', 'INFO'),
  expense('NON_EXPENSE', 'F', 'Зардал бус (өөрийн данс, хадгаламж)', 'EXCLUDE'),
  expense('SUSPICIOUS_EXPENSE', 'G', 'Сэжигтэй зардал', 'INFO'),
  expense('CHANNEL_EXPENSE', 'CH', 'Сувгийн зарлага (QPay, POS, ATM)', 'INFO'),
  expense('OTHER_EXPENSE', '?', 'Бусад зардал', 'INFO'),
];

/** [ангиллын код, priority, түлхүүр үгс] */
type RuleSpec = readonly [categoryCode: string, priority: number, patterns: readonly string[]];

function keywordRules(direction: TxnDirection, specs: readonly RuleSpec[]): BsaRuleDef[] {
  return specs.flatMap(([categoryCode, priority, patterns]) =>
    patterns.map((pattern): BsaRuleDef => ({ direction, matchType: 'KEYWORD', pattern, categoryCode, priority, source: 'ADMIN' })),
  );
}

const INCOME_RULES: readonly RuleSpec[] = [
  // Хөдөлмөрийн орлого (A, 100%)
  ['SALARY', NORMAL, ['цалин', 'сарын цалин', 'урамшуулал', 'нэмэгдэл', 'ажлын хөлс', 'хөдөлмөрийн хөлс', 'бонус', 'salary']],
  // Гэрээт ажлын орлого (D, 70%)
  ['CONTRACT_INCOME', NORMAL, ['гэрээний хөлс', 'үйлчилгээний хөлс', 'гэрээт ажил', 'зөвлөх үйлчилгээ', 'консалтинг']],
  // Бизнесийн орлого (B, 85%)
  ['BUSINESS_INCOME', NORMAL, ['борлуулалт', 'борлуулсан', 'худалдааны орлого', 'захиалгын төлбөр', 'нэхэмжлэх', 'qpay тооцоо', 'pos тооцоо']],
  ['BUSINESS_INCOME', WEAK, ['бараа']],
  // Бэлэн орлого (B, 50%)
  ['CASH_INCOME', NORMAL, ['бэлэн мөнгө байршуулсан', 'бэлэн мөнгө байршуулалт', 'бэлэн орлого', 'cash deposit']],
  // Идэвхгүй орлого (C, 100%)
  ['PASSIVE_INCOME', NORMAL, ['түрээс', 'хүү', 'хүүгийн орлого', 'ногдол ашиг', 'ногдол ашгийн', 'тэтгэвэр', 'тэтгэвр', 'тэтгэмж']],
  // Зээлийн олголт (0%)
  ['LOAN_PROCEEDS', STRONG, ['зээл олголт', 'зээлийн олголт', 'зээлийн үндсэн', 'цалингийн зээл']],
  ['LOAN_PROCEEDS', WEAK, ['зээл', 'зээлийн']],
  // Орлого бус: буцаалт, залруулга (0%)
  ['NON_INCOME', STRONG, ['буцаалт', 'буцаасан', 'буцаагдсан', 'буцаан олголт', 'залруулга', 'reversal', 'refund']],
  // Тогтмол бус (0%)
  ['IRREGULAR_INCOME', NORMAL, ['бэлэг', 'хандив', 'шагнал', 'тусламж']],
  // Өөрийн данснаас/хадгаламжаас (хасагдана)
  ['OWN_TRANSFER_IN', STRONG, ['өөрийн данс', 'хадгаламжаас', 'хадгаламж татсан']],
  // Сэжигтэй: мөрийтэй тоглоомын ялалт (0%)
  ['SUSPICIOUS_INCOME', STRONG, ['бооцоо', 'казино', 'casino', 'мөрийтэй тоглоом', 'bet']],
];

const EXPENSE_RULES: readonly RuleSpec[] = [
  // Зээлийн төлбөр (A)
  ['LOAN_PAYMENT', STRONG, [
    'зээлийн эргэн төлөлт', 'зээл төлөлт', 'зээлийн төлбөр', 'зээлийн хүү', 'цалингийн зээл', 'лизинг', 'хүү төлөлт', 'хүүгийн төлбөр',
  ]],
  ['LOAN_PAYMENT', NORMAL, ['алданги', 'эргэн төлөлт']],
  ['LOAN_PAYMENT', WEAK, ['зээл', 'зээлийн']],
  // Өрийн үүрэг (A)
  ['DEBT_OBLIGATION', NORMAL, ['өрийн төлбөр', 'өр төлөлт', 'кредит карт', 'storepay']],
  // Тогтмол зардал (B): түрээс, ашиглалт, холбоо, даатгал, сургалт
  ['FIXED_EXPENSE', NORMAL, [
    'түрээсийн төлбөр', 'түрээс', 'сөх', 'ашиглалтын зардал', 'цахилгаан', 'дулаан', 'ус', 'усны төлбөр', 'хийн төлбөр',
    'интернет', 'утасны төлбөр', 'unitel', 'mobicom', 'skytel', 'g mobile',
    'даатгал', 'даатгалын шимтгэл', 'сургалт', 'сургууль', 'хичээлийн төлбөр', 'цэцэрлэг',
  ]],
  ['FIXED_EXPENSE', STRONG, ['тээврийн хэрэгслийн татвар', 'үл хөдлөх хөрөнгийн татвар']],
  // Зайлшгүй зардал (C): хүнс, шатахуун, эм, эмнэлэг
  ['ESSENTIAL_EXPENSE', NORMAL, [
    'хүнс', 'супермаркет', 'номин', 'emart', 'шатахуун', 'бензин', 'дизель', 'түлш', 'нүүрс', 'эмийн сан', 'эмнэлэг', 'эмнэлгийн',
  ]],
  ['ESSENTIAL_EXPENSE', WEAK, ['дэлгүүр']],
  // Сонгон зардал (D)
  ['DISCRETIONARY_EXPENSE', NORMAL, ['ресторан', 'кафе', 'кофе', 'зоогийн газар', 'зочид буудал', 'аялал', 'нислэг', 'үсчин', 'гоо сайхан']],
  // Бизнесийн зардал (E)
  ['BUSINESS_EXPENSE', NORMAL, [
    'бараа материал', 'түүхий эд', 'нийлүүлэгч', 'цалин', 'ажлын хөлс', 'сурталчилгаа', 'ндш', 'ххоат', 'татвар',
  ]],
  ['BUSINESS_EXPENSE', STRONG, ['нийгмийн даатгал']],
  ['BUSINESS_EXPENSE', WEAK, ['бараа', 'худалдан авалт']],
  // Банкны шимтгэл (F)
  ['BANK_FEE', NORMAL, ['шимтгэл', 'хураамж', 'данс хөтөлсний хөлс', 'үйлчилгээний хөлс', 'комисс']],
  // Зардал бус: өөрийн данс, хадгаламж, буцаалт (хасагдана)
  ['NON_EXPENSE', STRONG, ['хадгаламж', 'term deposit', 'өөрийн данс', 'буцаалт', 'буцаасан', 'залруулга', 'refund']],
  // Сэжигтэй зардал (G): мөрийтэй тоглоом
  ['SUSPICIOUS_EXPENSE', STRONG, ['бооцоо', 'казино', 'casino', 'мөрийтэй тоглоом', 'онлайн тоглоом', 'betting', 'bet']],
];

export const DEFAULT_BSA_RULES: BsaRuleDef[] = [...keywordRules('INCOME', INCOME_RULES), ...keywordRules('EXPENSE', EXPENSE_RULES)];
