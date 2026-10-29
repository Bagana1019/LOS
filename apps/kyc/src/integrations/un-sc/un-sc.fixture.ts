// Mock-ийн deterministic fixture. БҮХ нэр, дугаар зохиомол — бодит хүн, байгууллагатай давхцахгүй (refId нь FIXTURE-UN- угтвартай).
// Nationality / identifier.country нь ISO 3166-1 alpha-2 (AmlSubject.countries-тай ижил) — RealUnScClient мөн ингэж хөрвүүлнэ.
import type { UnSanctionsSnapshot } from './un-sc.client';

export const UN_SC_FIXTURE: UnSanctionsSnapshot = {
  version: 'mock-2026-10',
  publishedAt: '2026-10-01T00:00:00.000Z',
  entries: [
    {
      // Хоёр alias (GOOD + LOW), төрсөн он 'YYYY-MM-DD' ба 'YYYY' хоёр хэлбэрээр
      refId: 'FIXTURE-UN-001',
      type: 'INDIVIDUAL',
      names: [
        { value: 'Orlan Vexmark Tarsen', quality: 'PRIMARY' },
        { value: 'Orlan Tarsen', quality: 'GOOD_ALIAS' },
        { value: 'O. Vex', quality: 'LOW_ALIAS' },
      ],
      datesOfBirth: ['1968-03-14', '1968'],
      nationalities: ['SY'],
      identifiers: [
        { type: 'Passport', value: 'FX0012345', country: 'SY' },
        { type: 'National Identification Number', value: 'FX-SY-000111', country: 'SY' },
      ],
      programme: 'FX_PROGRAMME_A',
      listedOn: '2019-04-12',
      remarks: 'Fictitious fixture entry.',
    },
    {
      // Кирилл бичиглэлтэй хувь хүн (латин alias-тай)
      refId: 'FIXTURE-UN-002',
      type: 'INDIVIDUAL',
      names: [
        { value: 'Велмонов Артак Левонович', quality: 'PRIMARY' },
        { value: 'Velmonov Artak Levonovich', quality: 'GOOD_ALIAS' },
        { value: 'Велмонов А.', quality: 'LOW_ALIAS' },
      ],
      datesOfBirth: ['1975-11-02'],
      nationalities: ['RU'],
      identifiers: [{ type: 'Passport', value: 'FX7000123', country: 'RU' }],
      programme: 'FX_PROGRAMME_B',
      listedOn: '2021-02-25',
    },
    {
      // Монгол форматтай (2 кирилл үсэг + 8 цифр) иргэний үнэмлэхний дугаартай хувь хүн — REGISTER_EXACT тест
      refId: 'FIXTURE-UN-003',
      type: 'INDIVIDUAL',
      names: [
        { value: 'Тестбаатар Фикстурсүх', quality: 'PRIMARY' },
        { value: 'Testbaatar Fixturesukh', quality: 'GOOD_ALIAS' },
      ],
      datesOfBirth: ['1981-06-30'],
      nationalities: ['MN'],
      identifiers: [{ type: 'National Identification Number', value: 'ЖЖ99999999', country: 'MN' }],
      programme: 'FX_PROGRAMME_A',
      listedOn: '2023-09-08',
    },
    {
      // 7 оронтой компанийн регистртэй байгууллага — REGISTER_EXACT тест
      refId: 'FIXTURE-UN-004',
      type: 'ENTITY',
      names: [
        { value: 'Altanvex Fixture Trading LLC', quality: 'PRIMARY' },
        { value: 'Altanvex Trading', quality: 'GOOD_ALIAS' },
      ],
      datesOfBirth: [],
      nationalities: [],
      identifiers: [{ type: 'Business Registration Number', value: '9999999', country: 'MN' }],
      programme: 'FX_PROGRAMME_B',
      listedOn: '2022-05-17',
    },
    {
      refId: 'FIXTURE-UN-005',
      type: 'ENTITY',
      names: [
        { value: 'Zalvor Maritime Holdings Ltd', quality: 'PRIMARY' },
        { value: 'Zalvor Maritime', quality: 'GOOD_ALIAS' },
        { value: 'ZMH', quality: 'LOW_ALIAS' },
      ],
      datesOfBirth: [],
      nationalities: [],
      identifiers: [],
      programme: 'FX_PROGRAMME_A',
      listedOn: '2020-11-30',
    },
    {
      // Зөвхөн төрсөн он, нэг нэр, баримт бичиггүй
      refId: 'FIXTURE-UN-006',
      type: 'INDIVIDUAL',
      names: [{ value: 'Karrel Dunmoor', quality: 'PRIMARY' }],
      datesOfBirth: ['1990'],
      nationalities: ['SD'],
      identifiers: [],
      programme: 'FX_PROGRAMME_B',
      listedOn: '2024-01-19',
    },
    {
      // Хоёр иргэншил, ойролцоо төрсөн огноо
      refId: 'FIXTURE-UN-007',
      type: 'INDIVIDUAL',
      names: [
        { value: 'Sabrel Nuvant Okoro', quality: 'PRIMARY' },
        { value: 'S. N. Okoro', quality: 'LOW_ALIAS' },
      ],
      datesOfBirth: ['1959-01-01', '1960'],
      nationalities: ['NG', 'CM'],
      identifiers: [{ type: 'Passport', value: 'FX5550199', country: 'NG' }],
      programme: 'FX_PROGRAMME_A',
      listedOn: '2018-07-03',
    },
    {
      refId: 'FIXTURE-UN-008',
      type: 'ENTITY',
      names: [
        { value: 'Northbridge Fixture Logistics Co', quality: 'PRIMARY' },
        { value: 'NB Fixture Logistics', quality: 'GOOD_ALIAS' },
      ],
      datesOfBirth: [],
      nationalities: [],
      identifiers: [{ type: 'Other', value: 'FX-TAX-0000042' }],
      programme: 'FX_PROGRAMME_B',
      listedOn: '2025-03-21',
    },
    {
      // Бичлэгийн хувилбартай нэр (fuzzy тулгалтын жишээ)
      refId: 'FIXTURE-UN-009',
      type: 'INDIVIDUAL',
      names: [
        { value: 'Ismael Quorrin Haldevane', quality: 'PRIMARY' },
        { value: 'Ismail Quorin Haldevan', quality: 'GOOD_ALIAS' },
      ],
      datesOfBirth: ['1972-09-21'],
      nationalities: ['IQ'],
      identifiers: [],
      programme: 'FX_PROGRAMME_A',
      listedOn: '2022-12-09',
    },
  ],
};
