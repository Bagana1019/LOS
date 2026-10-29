// MockOcrProvider-ийн built-in fixture-ууд. БҮХ ӨГӨГДӨЛ ЗОХИОМОЛ (SYNTHETIC): бодит хүн, байгууллага, регистр, данс БАЙХГҮЙ.
// Регистр 'ЖЮ85061512' нь формат/огноо зөв (1985-06-15, эрэгтэй) ч бодит хүнийх биш; IBAN нь mod-97 зөв боловч бодит данс биш.
// ТАБ ('\t') = баганын цоорхой (mock.layout.ts өргөн цоорхой болгоно). Хуулгын формат нь бодит банкных БИШ — TODO(samples).

export const SYNTHETIC_MARK = 'ЗОХИОМОЛ ӨГӨГДӨЛ - SYNTHETIC TEST FIXTURE';

export const SYNTHETIC_REGISTER_NO = 'ЖЮ85061512';
export const SYNTHETIC_IBAN = 'MN640005123456789012';
export const SYNTHETIC_OWN_IBAN = 'MN100004345678901234';

export const FIXTURE_ID_CARD_TEXT = [
  'МОНГОЛ УЛС / MONGOLIA',
  'ИРГЭНИЙ ҮНЭМЛЭХ / IDENTITY CARD',
  'Овог / Surname:\tДорж',
  'Нэр / Given name:\tБолд',
  'Хүйс / Sex:\tЭр',
  'Төрсөн огноо / Date of birth:\t1985.06.15',
  `Регистрийн дугаар / Register number:\t${SYNTHETIC_REGISTER_NO}`,
  'Үнэмлэхний дугаар / Card number:\tMN1234567',
  'Олгосон огноо / Date of issue:\t2020.04.12',
  'Хүчинтэй хугацаа / Valid until:\t2030.04.12',
  SYNTHETIC_MARK,
].join('\n');

export const FIXTURE_SALARY_CERTIFICATE_TEXT = [
  '"Тэнгэр Трейд" ХХК',
  'Улаанбаатар хот, Сүхбаатар дүүрэг, 1-р хороо',
  'Утас: 99112233',
  '',
  'ЦАЛИНГИЙН ТОДОРХОЙЛОЛТ',
  '',
  '2026 оны 09 сарын 15 өдөр\tДугаар 12/45',
  '',
  `Иргэн Дорж овогтой Болд (РД: ${SYNTHETIC_REGISTER_NO}) нь манай байгууллагад 2020 оноос хойш`,
  'Санхүүгийн албаны мэргэжилтнээр ажиллаж байгаа бөгөөд 2026 оны 3 сараас 9 сар',
  'хүртэлх 6 сарын дундаж цалин 1,800,000 (нэг сая найман зуун мянган) төгрөг байна.',
  '',
  'Энэхүү тодорхойлолтыг Хаан банкинд өгөв.',
  '',
  'Захирал:\tБ.Гэрэл',
  'Нягтлан бодогч:\tД.Номин',
  SYNTHETIC_MARK,
].join('\n');

interface SyntheticRow {
  date: string;
  time: string;
  description: string;
  debit?: number;
  credit?: number;
}

const SYNTHETIC_ROWS: readonly SyntheticRow[] = [
  { date: '2026.03.01', time: '09:15', description: 'Цалин 2026-02', credit: 1_800_000 },
  { date: '2026.03.03', time: '12:40', description: 'QPay худалдан авалт', debit: 45_000 },
  { date: '2026.03.05', time: '18:05', description: 'ATM бэлэн мөнгө авалт', debit: 300_000 },
  { date: '2026.03.10', time: '10:20', description: 'POS худалдан авалт Номин ТЦ', debit: 128_500 },
  { date: '2026.03.12', time: '14:30', description: 'Зээлийн төлбөр', debit: 450_000 },
  { date: '2026.03.15', time: '16:00', description: `Өөрийн данс руу шилжүүлэг ${SYNTHETIC_OWN_IBAN}`, debit: 200_000 },
  { date: '2026.03.20', time: '11:10', description: 'Түрээсийн орлого', credit: 600_000 },
  { date: '2026.03.25', time: '09:50', description: 'Шимтгэл', debit: 1_500 },
];
const SYNTHETIC_OPENING_BALANCE = 1_000_000;

/** 1234567.5 → '1,234,567.50' (Intl-гүй: локалиас хамаарахгүй, deterministic) */
export function formatSyntheticAmount(n: number): string {
  const [int, frac] = n.toFixed(2).split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

/** Үлдэгдлийн гинж ЗӨВ (opening + credit - debit = balance) зохиомол хуулга. Баганууд: Огноо Цаг Утга Зарлага Орлого Үлдэгдэл */
export function buildSyntheticStatementText(): string {
  let balance = SYNTHETIC_OPENING_BALANCE;
  const body = SYNTHETIC_ROWS.map((r) => {
    balance += (r.credit ?? 0) - (r.debit ?? 0);
    return [r.date, r.time, r.description, formatSyntheticAmount(r.debit ?? 0), formatSyntheticAmount(r.credit ?? 0), formatSyntheticAmount(balance)].join('\t');
  });
  return [
    'ТУРШИЛТЫН ДАНСНЫ ХУУЛГА (бодит банкны формат БИШ)',
    'Дансны эзэмшигч:\tДорж Болд',
    `Дансны дугаар:\t${SYNTHETIC_IBAN}`,
    'Хугацаа:\t2026.03.01 - 2026.03.31',
    `Эхний үлдэгдэл:\t${formatSyntheticAmount(SYNTHETIC_OPENING_BALANCE)}`,
    'Огноо\tЦаг\tГүйлгээний утга\tЗарлага\tОрлого\tҮлдэгдэл',
    ...body,
    `Эцсийн үлдэгдэл:\t${formatSyntheticAmount(balance)}`,
    SYNTHETIC_MARK,
  ].join('\n');
}

/** Файлын нэрний хэсгээр (жижиг үсэг, `_`/зай → `-`) сонгох built-in fixture. Дараалал: id-card, salary, statement. */
export const MOCK_BUILTIN_FIXTURES: ReadonlyArray<{ key: string; text: string }> = [
  { key: 'id-card', text: FIXTURE_ID_CARD_TEXT },
  { key: 'salary', text: FIXTURE_SALARY_CERTIFICATE_TEXT },
  { key: 'statement', text: buildSyntheticStatementText() },
];
