import { describe, expect, it } from 'vitest';
import { AmlPolicy, AmlSubject, DEFAULT_AML_POLICY } from '@los/contracts';
import type { FatfSnapshot } from '../../../integrations/fatf/fatf.client';
import type { UnSanctionedParty, UnSanctionsSnapshot } from '../../../integrations/un-sc/un-sc.client';
import { UN_SC_FIXTURE } from '../../../integrations/un-sc/un-sc.fixture';
import type { BlacklistProjection } from '../aml.ports';
import { quantiseScore, runScreening, type EngineInput } from './screening-engine';

const REGISTER = 'УБ12345678';
const subject = (over: Record<string, unknown> = {}): AmlSubject =>
  AmlSubject.parse({ subjectType: 'INDIVIDUAL', registerNo: REGISTER, lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ', ...over });

const party = (over: Partial<UnSanctionedParty> & Pick<UnSanctionedParty, 'refId'>): UnSanctionedParty => ({
  type: 'INDIVIDUAL', names: [{ value: 'Bat Erdene Ganbold', quality: 'PRIMARY' }], datesOfBirth: [], nationalities: [], identifiers: [],
  programme: 'TEST_PROGRAMME', listedOn: '2020-01-01', ...over,
});
const un = (...entries: UnSanctionedParty[]): UnSanctionsSnapshot => ({ version: 'un-v1', publishedAt: '2026-10-01T00:00:00Z', entries });
const fatf: FatfSnapshot = {
  version: 'fatf-v1', publishedAt: '2026-10-01T00:00:00Z',
  entries: [
    { countryCode: 'KP', countryName: 'Fixtureland North', category: 'CALL_FOR_ACTION', listedOn: '2020-02-21' },
    { countryCode: 'ZZ', countryName: 'Fixtureland Grey', category: 'INCREASED_MONITORING', listedOn: '2024-06-28' },
  ],
};
const listed = (over: Partial<BlacklistProjection> = {}): BlacklistProjection => ({
  id: 'bl-1', orgId: 'org-1', registerNoHash: 'h', customerType: 'INDIVIDUAL', name: 'Тест Хэрэглэгч', listType: 'DELINQUENT',
  reasonCode: 'OVERDUE_90', isActive: true, changedAt: new Date('2026-10-01T00:00:00Z'), ...over,
});
const input = (over: Partial<EngineInput> = {}): EngineInput => ({
  subject: subject(), policy: DEFAULT_AML_POLICY, lists: ['UN_SC', 'FATF', 'INTERNAL_BLACKLIST'], ...over,
});
const policy = (over: Record<string, unknown>) => AmlPolicy.parse(over);

describe('UN sanctions matching', () => {
  it('finds nothing without a snapshot or when the list is not requested', () => {
    expect(runScreening(input())).toEqual([]);
    expect(runScreening(input({ lists: ['FATF'], un: un(party({ refId: 'T-1' })) }))).toEqual([]);
  });

  it('matches a Cyrillic customer name against a Latin list name as NAME_EXACT with a BLOCKING hit', () => {
    const [h, ...rest] = runScreening(input({ un: un(party({ refId: 'T-1' })) }));
    expect(rest).toEqual([]);
    expect(h).toMatchObject({ list: 'UN_SC', matchType: 'NAME_EXACT', score: 1, severity: 'BLOCKING', entryRef: 'T-1', listVersion: 'un-v1', entryName: 'Bat Erdene Ganbold' });
    expect(h.details).toMatchObject({ programme: 'TEST_PROGRAMME', partyType: 'INDIVIDUAL', matchedName: 'Bat Erdene Ganbold', dateOfBirth: 'UNKNOWN' });
  });

  it('reports spelling variants as NAME_FUZZY above the review threshold', () => {
    const s = subject({ lastName: undefined, firstName: 'Mohammed Al-Rashid' });
    const [h] = runScreening(input({ subject: s, un: un(party({ refId: 'T-2', names: [{ value: 'Muhammad Al Rashid', quality: 'PRIMARY' }] })) }));
    expect(h.matchType).toBe('NAME_FUZZY');
    expect(h.score).toBeGreaterThanOrEqual(DEFAULT_AML_POLICY.reviewThreshold);
    expect(h.score).toBeLessThan(1);
  });

  it('does not report partial name overlaps or different people', () => {
    const s = subject({ lastName: undefined, firstName: 'Bat Erdene' });
    expect(runScreening(input({ subject: s, un: un(party({ refId: 'T-1' }), party({ refId: 'T-3', names: [{ value: 'Ivan Sidorov', quality: 'PRIMARY' }] })) }))).toEqual([]);
  });

  it('requires the strong threshold for LOW_ALIAS names', () => {
    const s = subject({ lastName: undefined, firstName: 'Mohammed Al-Rashid' });
    const low = party({ refId: 'T-4', names: [{ value: 'Unrelated Primary', quality: 'PRIMARY' }, { value: 'Muhammad Al Rashid', quality: 'LOW_ALIAS' }] });
    expect(runScreening(input({ subject: s, un: un(low) }))).toEqual([]);
    const strong = subject({ lastName: 'Ганболд', firstName: 'Бат-Эрдэнэ' });
    const exactLow = party({ refId: 'T-5', names: [{ value: 'Unrelated Primary', quality: 'PRIMARY' }, { value: 'Bat Erdene Ganbold', quality: 'LOW_ALIAS' }] });
    expect(runScreening(input({ subject: strong, un: un(exactLow) }))).toHaveLength(1);
  });

  it('uses aliases from the request as extra name variants', () => {
    const s = subject({ lastName: 'Тест', firstName: 'Нэр', aliases: ['Bat Erdene Ganbold'] });
    expect(runScreening(input({ subject: s, un: un(party({ refId: 'T-1' })) }))).toHaveLength(1);
  });

  describe('date of birth', () => {
    const fuzzySubject = (birthDate?: string) => subject({ lastName: undefined, firstName: 'Mohammed Al-Rashid', birthDate });
    const entry = party({ refId: 'T-6', names: [{ value: 'Muhammad Al Rashid', quality: 'PRIMARY' }], datesOfBirth: ['1980', '1980-05-01'] });

    it('keeps a fuzzy hit when the birth year matches or is unknown', () => {
      expect(runScreening(input({ subject: fuzzySubject('1980-09-09'), un: un(entry) }))[0]?.details).toMatchObject({ dateOfBirth: 'MATCH' });
      expect(runScreening(input({ subject: fuzzySubject(), un: un(entry) }))[0]?.details).toMatchObject({ dateOfBirth: 'UNKNOWN' });
    });
    it('drops a fuzzy hit when the birth year differs', () => {
      expect(runScreening(input({ subject: fuzzySubject('1999-01-01'), un: un(entry) }))).toEqual([]);
    });
    it('still reports an identical name with a different birth year, flagged as MISMATCH', () => {
      const same = party({ refId: 'T-7', datesOfBirth: ['1980'] });
      const [h] = runScreening(input({ subject: subject({ birthDate: '1999-01-01' }), un: un(same) }));
      expect(h.details).toMatchObject({ dateOfBirth: 'MISMATCH' });
    });
  });

  describe('identifiers', () => {
    const withId = party({ refId: 'T-8', names: [{ value: 'Completely Different Name', quality: 'PRIMARY' }], identifiers: [{ type: 'National Identification Number', value: 'уб 12345678', country: 'MN' }] });
    it('matches the register number exactly regardless of the name and never leaks the register', () => {
      const [h] = runScreening(input({ un: un(withId) }));
      expect(h).toMatchObject({ matchType: 'REGISTER_EXACT', score: 1, matchedValue: '*******678' });
      expect(JSON.stringify(h)).not.toContain(REGISTER);
      expect(JSON.stringify(h)).not.toContain('12345678');
      expect(h.details).toMatchObject({ identifierType: 'National Identification Number' });
    });
    it('treats Latin look-alike letters as the same register', () => {
      const cyrillic = party({ refId: 'T-12', names: [{ value: 'Completely Different Name', quality: 'PRIMARY' }], identifiers: [{ type: 'ID', value: 'АО12345678' }] });
      expect(runScreening(input({ subject: subject({ registerNo: 'AO12345678' }), un: un(cyrillic) }))).toHaveLength(1);
    });
    // [7]/[16]: үл үзэгдэх тэмдэгт, fullwidth, араб цифртэй хуулсан регистр жагсаалтын баримттай таарахгүй байсан
    it('matches a register pasted with invisible, fullwidth or Arabic-Indic characters', () => {
      for (const registerNo of ['УБ\u200b12345678', 'УБ１２３４５６７８', 'УБ١٢٣٤٥٦٧٨', 'УБ\u201312345678/']) {
        const hits = runScreening(input({ subject: subject({ registerNo, firstName: 'Zzz', lastName: undefined }), un: un(withId) }));
        expect(hits.map((h) => h.matchType), registerNo).toEqual(['REGISTER_EXACT']);
      }
    });
    it('matches Latin Y, Cyrillic Ү and Cyrillic У as the same register letter', () => {
      const entry = party({ refId: 'T-13', names: [{ value: 'Completely Different Name', quality: 'PRIMARY' }], identifiers: [{ type: 'ID', value: 'УА12345678', country: 'MN' }] });
      for (const registerNo of ['YA12345678', '\u04aeА12345678', 'УА12345678']) {
        expect(runScreening(input({ subject: subject({ registerNo }), un: un(entry) })), registerNo).toHaveLength(1);
      }
    });
    // [12]: нормчилсны дараа хоосон регистр нь хоосон болдог баримттай таарч BLOCKING hit өгдөг байсан
    it('never matches an empty normalised register against an identifier that also normalises to empty', () => {
      const blank = party({ refId: 'T-14', names: [{ value: 'Completely Different Name', quality: 'PRIMARY' }], identifiers: [{ type: 'Other', value: '---' }, { type: 'Other', value: '\u200b' }] });
      // zod ийм регистрийг хаадаг; engine нь цэвэр функц тул зөвхөн хамгаалалтын давхарга
      const raw = { ...subject(), registerNo: '...' };
      expect(runScreening(input({ subject: raw, un: un(blank) }))).toEqual([]);
      expect(runScreening(input({ subject: { ...raw, registerNo: '\u200b' }, un: un(blank) }))).toEqual([]);
    });
    it('skips identifiers issued by a country the subject has no tie to (default MN)', () => {
      const foreign = party({ refId: 'T-15', names: [{ value: 'Completely Different Name', quality: 'PRIMARY' }], identifiers: [{ type: 'Passport', value: 'АО12345678', country: 'SY' }] });
      const s = subject({ registerNo: 'AO12345678' });
      expect(runScreening(input({ subject: s, un: un(foreign) }))).toEqual([]);
      expect(runScreening(input({ subject: { ...s, countries: ['MN'] }, un: un(foreign) }))).toEqual([]);
      // Сирийн иргэншилтэй (хоёр иргэншил) бол мөн харьцуулна, улсын код том/жижиг үсэгт хамаарахгүй
      expect(runScreening(input({ subject: { ...s, countries: ['MN', 'SY'] }, un: un(foreign) })).map((h) => h.matchType)).toEqual(['REGISTER_EXACT']);
      const lower = party({ refId: 'T-16', names: [{ value: 'Completely Different Name', quality: 'PRIMARY' }], identifiers: [{ type: 'Passport', value: 'АО12345678', country: 'sy' }] });
      expect(runScreening(input({ subject: { ...s, countries: ['SY'] }, un: un(lower) }))).toHaveLength(1);
    });
    // review [1]: aml.service нь улсыг үргэлж ['MN'] болгон нөхдөг тул гадаад баримт (UN-ийн ихэнх) улсын шүүлтүүрт хэзээ ч таардаггүй байсан
    it('compares a register that does not look Mongolian against every identifier, whatever the country list says', () => {
      const foreign = (countries: string[]) => AmlSubject.parse({ subjectType: 'INDIVIDUAL', registerNo: 'FX0012345', firstName: 'Zzz', lastName: 'Qqq', countries });
      for (const countries of [[], ['MN'], ['IQ'], ['MN', 'IQ']]) {
        const hits = runScreening(input({ subject: foreign(countries), un: UN_SC_FIXTURE }));
        expect(hits.map((h) => `${h.entryRef}:${h.matchType}`), JSON.stringify(countries)).toEqual(['FIXTURE-UN-001:REGISTER_EXACT']);
        expect(hits[0].details).toMatchObject({ identifierType: 'Passport' });
      }
    });
    it('still skips a foreign-country identifier for the two Mongolian register shapes', () => {
      const foreign = (type: string, value: string) => party({ refId: 'T-30', names: [{ value: 'Completely Different Name', quality: 'PRIMARY' }], identifiers: [{ type, value, country: 'SY' }] });
      // хувь хүн: 2 кирилл үсэг + 8 цифр (латин look-alike-аар бичсэн ч нормчлогдоод адил)
      for (const [registerNo, listed] of [['УБ12345678', 'УБ12345678'], ['уб 12345678', 'УБ12345678'], ['AO12345678', 'АО12345678']]) {
        const s = subject({ registerNo });
        expect(runScreening(input({ subject: s, un: un(foreign('Passport', listed)) })), registerNo).toEqual([]);
        expect(runScreening(input({ subject: { ...s, countries: ['SY'] }, un: un(foreign('Passport', listed)) })), registerNo).toHaveLength(1);
      }
      // ААН: яг 7 цифр
      const org = subject({ subjectType: 'LEGAL_ENTITY', registerNo: '1234567', lastName: undefined, firstName: 'Zzz' });
      expect(runScreening(input({ subject: org, un: un(foreign('Passport', '1234567')) }))).toEqual([]);
      expect(runScreening(input({ subject: { ...org, countries: ['SY'] }, un: un(foreign('Passport', '1234567')) }))).toHaveLength(1);
    });
    it('does not gate a register of any other shape (8 digits, 6 digits, letters only, a longer passport number)', () => {
      const foreign = (value: string) => party({ refId: 'T-31', names: [{ value: 'Completely Different Name', quality: 'PRIMARY' }], identifiers: [{ type: 'Passport', value, country: 'SY' }] });
      for (const registerNo of ['12345678', '123456', 'ABCDEFG', 'XA1234567', 'N0123456789', 'А1234567']) {
        const s = subject({ registerNo, firstName: 'Zzz', lastName: undefined });
        expect(runScreening(input({ subject: s, un: un(foreign(registerNo)) })).map((h) => h.matchType), registerNo).toEqual(['REGISTER_EXACT']);
      }
    });
    it('still compares identifiers without a country or with a country that is not ISO alpha-2', () => {
      const noCountry = party({ refId: 'T-17', names: [{ value: 'Completely Different Name', quality: 'PRIMARY' }], identifiers: [{ type: 'Passport', value: 'АО12345678' }] });
      const odd = party({ refId: 'T-18', names: [{ value: 'Completely Different Name', quality: 'PRIMARY' }], identifiers: [{ type: 'Passport', value: 'АО12345678', country: 'Syrian Arab Republic' }] });
      const s = subject({ registerNo: 'AO12345678' });
      expect(runScreening(input({ subject: s, un: un(noCountry) }))).toHaveLength(1);
      expect(runScreening(input({ subject: s, un: un(odd) }))).toHaveLength(1);
    });
    it('uses the identifier of the right country when an entry lists several', () => {
      const multi = party({ refId: 'T-19', names: [{ value: 'Completely Different Name', quality: 'PRIMARY' }], identifiers: [
        { type: 'Passport', value: '1234567', country: 'IR' }, { type: 'National Identification Number', value: 'ЖЖ99999999', country: 'MN' },
      ] });
      expect(runScreening(input({ subject: subject({ registerNo: 'ЖЖ99999999' }), un: un(multi) })).map((h) => h.matchType)).toEqual(['REGISTER_EXACT']);
      expect(runScreening(input({ subject: subject({ subjectType: 'LEGAL_ENTITY', registerNo: '1234567', lastName: undefined, firstName: 'Zzz' }), un: un(multi) }))).toEqual([]);
    });
    it('prefers the register match over a name match for the same entry', () => {
      const both = party({ refId: 'T-9', identifiers: [{ type: 'ID', value: REGISTER }] });
      const hits = runScreening(input({ un: un(both) }));
      expect(hits).toHaveLength(1);
      expect(hits[0].matchType).toBe('REGISTER_EXACT');
    });
  });

  it('does not name-match an individual against an entity (or the reverse)', () => {
    const entity = party({ refId: 'T-10', type: 'ENTITY' });
    expect(runScreening(input({ un: un(entity) }))).toEqual([]);
    const org = subject({ subjectType: 'LEGAL_ENTITY', registerNo: '1234567', lastName: undefined, firstName: 'Bat Erdene Ganbold' });
    expect(runScreening(input({ subject: org, un: un(party({ refId: 'T-1' })) }))).toEqual([]);
    expect(runScreening(input({ subject: org, un: un(entity) }))).toHaveLength(1);
  });

  it('downgrades to WARNING when the policy does not block on sanctions', () => {
    const [h] = runScreening(input({ policy: policy({ blockOnSanctionsHit: false }), un: un(party({ refId: 'T-1' })) }));
    expect(h.severity).toBe('WARNING');
  });

  it('honours custom thresholds', () => {
    const s = subject({ lastName: undefined, firstName: 'Mohammed Al-Rashid' });
    const entry = party({ refId: 'T-11', names: [{ value: 'Muhammad Al Rashid', quality: 'PRIMARY' }] });
    expect(runScreening(input({ subject: s, policy: policy({ reviewThreshold: 1, strongThreshold: 1 }), un: un(entry) }))).toEqual([]);
  });

  it('orders hits by score then reference, deterministically', () => {
    const entries = [party({ refId: 'B-2' }), party({ refId: 'A-1' }), party({ refId: 'C-3', names: [{ value: 'Bat Erdene Ganbolt', quality: 'PRIMARY' }] })];
    const hits = runScreening(input({ un: un(...entries) }));
    expect(hits.map((h) => h.entryRef)).toEqual(['A-1', 'B-2', 'C-3']);
    expect(runScreening(input({ un: un(...entries) }))).toEqual(hits);
  });
});

describe('FATF jurisdiction matching', () => {
  it('flags listed countries with the list category as evidence', () => {
    const hits = runScreening(input({ subject: subject({ countries: ['mn', 'kp', 'zz'] }), fatf }));
    expect(hits.map((h) => [h.entryRef, h.matchType, h.severity, h.details.category])).toEqual([
      ['KP', 'COUNTRY', 'WARNING', 'CALL_FOR_ACTION'],
      ['ZZ', 'COUNTRY', 'WARNING', 'INCREASED_MONITORING'],
    ]);
    expect(hits[0]).toMatchObject({ list: 'FATF', score: 1, listVersion: 'fatf-v1', entryName: 'Fixtureland North' });
  });
  it('blocks only CALL_FOR_ACTION and only when the policy says so', () => {
    const p = policy({ blockOnFatfCallForAction: true });
    const hits = runScreening(input({ subject: subject({ countries: ['KP', 'ZZ'] }), policy: p, fatf }));
    expect(hits.map((h) => h.severity)).toEqual(['BLOCKING', 'WARNING']);
  });
  it('finds nothing for unlisted or missing countries', () => {
    expect(runScreening(input({ subject: subject({ countries: ['MN'] }), fatf }))).toEqual([]);
    expect(runScreening(input({ subject: subject({ countries: [] }), fatf }))).toEqual([]);
  });
});

describe('internal blacklist', () => {
  it('is warning-only by default (BR-9)', () => {
    const [h] = runScreening(input({ blacklist: [listed()] }));
    expect(h).toMatchObject({ list: 'INTERNAL_BLACKLIST', matchType: 'REGISTER_EXACT', score: 1, severity: 'WARNING', entryRef: 'bl-1', entryName: 'Тест Хэрэглэгч', listVersion: 'live' });
    expect(h.details).toEqual({ listType: 'DELINQUENT', reasonCode: 'OVERDUE_90', customerType: 'INDIVIDUAL' });
  });
  it('can be made blocking by policy', () => {
    expect(runScreening(input({ policy: policy({ blockOnInternalBlacklist: true }), blacklist: [listed()] }))[0].severity).toBe('BLOCKING');
  });
  it('ignores inactive rows and unrequested lists', () => {
    expect(runScreening(input({ blacklist: [listed({ isActive: false })] }))).toEqual([]);
    expect(runScreening(input({ lists: ['UN_SC'], blacklist: [listed()] }))).toEqual([]);
  });
  it('returns one hit per entry in a stable order', () => {
    const hits = runScreening(input({ blacklist: [listed({ id: 'bl-2' }), listed({ id: 'bl-1', listType: 'FRAUD' })] }));
    expect(hits.map((h) => h.entryRef)).toEqual(['bl-1', 'bl-2']);
  });
});

it('combines all lists in a single pass', () => {
  const hits = runScreening(input({ subject: subject({ countries: ['KP'] }), un: un(party({ refId: 'T-1' })), fatf, blacklist: [listed()] }));
  expect(hits.map((h) => h.list)).toEqual(['UN_SC', 'FATF', 'INTERNAL_BLACKLIST']);
});

describe('name variants', () => {
  it('matches a name written with different word boundaries (FR-13.1)', () => {
    const entry = party({ refId: 'T-20', names: [{ value: 'Bat Erdene Ganbold', quality: 'PRIMARY' }] });
    const s = subject({ lastName: 'Ганболд', firstName: 'Батэрдэнэ' });
    const [h] = runScreening(input({ subject: s, un: un(entry) }));
    // нормчилсон нэр ижил биш (хил хязгаар ба дараалал зөрсөн) тул NAME_EXACT биш, харин NAME_FUZZY 0.97 (review [8])
    expect(h).toMatchObject({ matchType: 'NAME_FUZZY', score: 0.97, entryRef: 'T-20' });
    const arabic = party({ refId: 'T-21', names: [{ value: 'Abdul Rahman Al Saud', quality: 'PRIMARY' }] });
    expect(runScreening(input({ subject: subject({ lastName: undefined, firstName: 'Abdulrahman Alsaud' }), un: un(arabic) }))).toHaveLength(1);
  });

  it('matches the passport rendering of ө (Ulzii) against a list name written either way', () => {
    const s = subject({ lastName: 'Мөнхөө', firstName: 'Өлзий' });
    for (const value of ['Ulzii Munkhuu', 'Olzii Monkhoo']) {
      const hits = runScreening(input({ subject: s, un: un(party({ refId: 'T-22', names: [{ value, quality: 'PRIMARY' }] })) }));
      expect(hits.map((h) => h.matchType), value).toEqual(['NAME_EXACT']);
    }
  });

  it('matches a mixed-script look-alike spelling', () => {
    const s = subject({ lastName: undefined, firstName: '\u041d\u043e\u0440\u0440er Smith' }); // Cyrillic Н о р р + Latin er: looks like "Hopper Smith"
    expect(runScreening(input({ subject: s, un: un(party({ refId: 'T-23', names: [{ value: 'Hopper Smith', quality: 'PRIMARY' }] })) }))).toHaveLength(1);
  });

  it('matches Kazakh and Serbian spellings against the Latin list name', () => {
    const kz = subject({ lastName: undefined, firstName: 'Нұрсұлтан Қайратұлы' });
    expect(runScreening(input({ subject: kz, un: un(party({ refId: 'T-24', names: [{ value: 'Nursultan Kairatuly', quality: 'PRIMARY' }] })) }))).toHaveLength(1);
    const rs = subject({ lastName: undefined, firstName: 'Ђорђе Милошевић' });
    expect(runScreening(input({ subject: rs, un: un(party({ refId: 'T-25', names: [{ value: 'Djordje Miloshevic', quality: 'PRIMARY' }] })) }))).toHaveLength(1);
  });
});

describe('legal entities', () => {
  const entityParty = (over: Partial<UnSanctionedParty> & Pick<UnSanctionedParty, 'refId'>) => party({ type: 'ENTITY', ...over });
  const org = (firstName: string) => subject({ subjectType: 'LEGAL_ENTITY', registerNo: '1234567', lastName: undefined, firstName });

  // [6]: ХХК/LLC гэх мэт хуулийн хэлбэр нь ердийн токен байсан тул нэр ижил байсан ч оноо босгоос доош унадаг байсан
  it('reports an entity whose legal form differs or is missing', () => {
    const listed = entityParty({ refId: 'E-1', names: [{ value: 'Altan LLC', quality: 'PRIMARY' }] });
    for (const name of ['Altan ХХК', 'Altan ХК', 'Altan', 'Altan Limited']) {
      const hits = runScreening(input({ subject: org(name), un: un(listed) }));
      expect(hits.map((h) => [h.entryRef, h.matchType, h.score]), name).toEqual([['E-1', 'NAME_EXACT', 1]]);
    }
  });

  it('matches the Mongolian registration name against the Latin list name', () => {
    const listed = entityParty({ refId: 'E-2', names: [{ value: 'Mongol Treid Co', quality: 'PRIMARY' }] });
    expect(runScreening(input({ subject: org('Монгол Трейд ХХК'), un: un(listed) }))).toHaveLength(1);
  });

  it('does not strip anything for individuals, and does not report a different company', () => {
    const person = party({ refId: 'P-1', names: [{ value: 'Altan LLC', quality: 'PRIMARY' }] });
    expect(runScreening(input({ subject: subject({ lastName: undefined, firstName: 'Altan ХХК' }), un: un(person) }))).toEqual([]);
    const other = entityParty({ refId: 'E-3', names: [{ value: 'Zalvor Trading LLC', quality: 'PRIMARY' }] });
    expect(runScreening(input({ subject: org('Altanvex Trading ХХК'), un: un(other) }))).toEqual([]);
  });

  it('finds the fixture entity FIXTURE-UN-004 through its alias regardless of the designator', () => {
    const hits = runScreening(input({ subject: org('Altanvex Trading ХХК'), un: UN_SC_FIXTURE }));
    expect(hits.map((h) => h.entryRef)).toEqual(['FIXTURE-UN-004']);
    expect(hits[0].matchType).toBe('NAME_EXACT');
  });
});

describe('numbered entities and the policy thresholds (review [12])', () => {
  const entityParty = (refId: string, ...values: string[]) => party({ type: 'ENTITY', refId, names: values.map((value) => ({ value, quality: 'PRIMARY' as const })) });
  const org = (firstName: string) => subject({ subjectType: 'LEGAL_ENTITY', registerNo: '1234567', lastName: undefined, firstName });
  const group = (n: string) => `Altan Gobi Mining Holdings Group ${n} LLC`;

  it.each([['1', '2'], ['18', '81'], ['88', '8'], ['8', '88']])('does not report Group %s as Group %s', (a, b) => {
    expect(runScreening(input({ subject: org(group(a)), un: un(entityParty('E-7', group(b))) }))).toEqual([]);
  });

  it('still reports the same number as an exact name match', () => {
    const hits = runScreening(input({ subject: org(group('18')), un: un(entityParty('E-7', group('18'))) }));
    expect(hits.map((h) => [h.matchType, h.score])).toEqual([['NAME_EXACT', 1]]);
  });

  it('keeps the ceiling below the policy review threshold, whatever it is (not a fixed constant)', () => {
    // 0.4 < matching-ийн анхдагч дээд хязгаар 0.5: тогтмол 0.5 бол Group 1 ~ Group 2 энэ бодлогоор hit болох байсан
    for (const reviewThreshold of [0.4, 0.1, 0.88, 0.97]) {
      const p = policy({ reviewThreshold, strongThreshold: Math.max(0.95, reviewThreshold) });
      expect(runScreening(input({ subject: org(group('1')), policy: p, un: un(entityParty('E-7', group('2'))) })), String(reviewThreshold)).toEqual([]);
    }
  });

  it('does not let a digit conflict on one name hide a match on another name of the same entry', () => {
    const entry = entityParty('E-8', group('2'), 'Altan Gobi Mining Holdings Group LLC');
    const hits = runScreening(input({ subject: org(group('1')), un: un(entry) }));
    expect(hits).toHaveLength(1);
    expect(hits[0].details).toMatchObject({ matchedName: 'Altan Gobi Mining Holdings Group LLC' });
  });
});

describe('name variants: vowel spellings, boundary shifts and initials (review [3], [4], [8])', () => {
  const entryOf = (value: string, quality: 'PRIMARY' | 'LOW_ALIAS' = 'PRIMARY', over: Partial<UnSanctionedParty> = {}) =>
    party({ refId: 'V-1', names: [{ value, quality }], ...over });
  const subjectOf = (firstName: string, birthDate?: string) => subject({ lastName: undefined, firstName, birthDate });

  it('reports Mohammed Omar / Muhammad Umar as a fuzzy hit with the vowel-variant score', () => {
    const [h] = runScreening(input({ subject: subjectOf('Mohammed Omar'), un: un(entryOf('Muhammad Umar')) }));
    expect(h).toMatchObject({ matchType: 'NAME_FUZZY', score: 0.93, entryRef: 'V-1' });
  });

  it('keeps a vowel variant out when the birth year differs or the alias is weak (both need the strong threshold)', () => {
    expect(runScreening(input({ subject: subjectOf('Mohammed Omar', '1999-01-01'), un: un(entryOf('Muhammad Umar', 'PRIMARY', { datesOfBirth: ['1980'] })) }))).toEqual([]);
    expect(runScreening(input({ subject: subjectOf('Mohammed Omar'), un: un(entryOf('Muhammad Umar', 'LOW_ALIAS')) }))).toEqual([]);
    expect(runScreening(input({ subject: subjectOf('Mohammed Omar', '1980-02-02'), un: un(entryOf('Muhammad Umar', 'PRIMARY', { datesOfBirth: ['1980'] })) }))).toHaveLength(1);
  });

  it('does not report sibling-style names that differ in one whole short name', () => {
    expect(runScreening(input({ subject: subjectOf('Malik bin Majid bin Umar al-Sabah'), un: un(entryOf('Nasir bin Majid bin Umar al-Sabah')) }))).toEqual([]);
    expect(runScreening(input({ subject: subjectOf('Б.Ганбаатар'), un: un(entryOf('D. Ganbaatar')) }))).toEqual([]);
  });

  it('never labels a rotation, boundary shift or initial match NAME_EXACT, and drops the colliding short names', () => {
    for (const [name, listed] of [['Evans S', 'Evans E'], ['Hill L', 'Hill K'], ['Li Na', 'Lin A'], ['Hall L', 'K Hall']]) {
      expect(runScreening(input({ subject: subjectOf(name), un: un(entryOf(listed)) })), `${name} / ${listed}`).toEqual([]);
    }
    for (const [name, listed] of [['Abdul Rahman', 'Abdulrahman'], ['Bat Tuvshin', 'Battuvshin'], ['Ганболд Батэрдэнэ', 'Bat Erdene Ganbold']]) {
      const hits = runScreening(input({ subject: subjectOf(name), un: un(entryOf(listed)) }));
      expect(hits.map((h) => [h.matchType, h.score]), `${name} / ${listed}`).toEqual([['NAME_FUZZY', 0.97]]);
    }
  });
});

describe('legal entities: designators written with dots or in Russian (review [6], [9])', () => {
  const org = (firstName: string) => subject({ subjectType: 'LEGAL_ENTITY', registerNo: '1234567', lastName: undefined, firstName });
  const listed = (value: string) => party({ type: 'ENTITY', refId: 'E-9', names: [{ value, quality: 'PRIMARY' }] });

  it.each([
    ['Al Noor Trading L.L.C.', 'Al Noor Trading LLC'],
    ['Zorya Shipping F.Z.E.', 'Zorya Shipping FZE'],
    ['Zorya Shipping P.J.S.C.', 'Zorya Shipping JSC'],
    ['Zorya Shipping Pvt. Ltd.', 'Zorya Shipping'],
    ['Алтан Х.Х.К', 'Altan LLC'],
    ['ООО Ромашка', 'Romashka LLC'],
  ])('%s is reported against %s as an exact name', (customer, onList) => {
    const hits = runScreening(input({ subject: org(customer), un: un(listed(onList)) }));
    expect(hits.map((h) => [h.matchType, h.score])).toEqual([['NAME_EXACT', 1]]);
  });

  it('keeps a one-letter typo next to a shared designator reportable (stripping only adds recall)', () => {
    for (const [customer, onList] of [['Golomt ХХК', 'Gmlomt ХХК'], ['Golomt Co', 'Gclomt Co'], ['Ming Tai ХК', 'Mxng Tai ХК']]) {
      expect(runScreening(input({ subject: org(customer), un: un(listed(onList)) })), `${customer} / ${onList}`).toHaveLength(1);
    }
  });
});

describe('quantiseScore', () => {
  it('rounds to 4 decimals, the precision of aml_hit.score Decimal(5,4)', () => {
    expect(quantiseScore(0.9083333333333334)).toBe(0.9083);
    expect(quantiseScore(0.87996)).toBe(0.88);
    expect(quantiseScore(0)).toBe(0);
    expect(quantiseScore(1)).toBe(1);
    expect(quantiseScore(0.5)).toBe(0.5);
  });

  it('never rounds a non-exact score up to 1, so score === 1 still means "normalised names identical"', () => {
    expect(quantiseScore(0.99996)).toBe(0.9999);
    expect(quantiseScore(0.9999999)).toBe(0.9999);
    expect(quantiseScore(0.99994)).toBe(0.9999);
  });
});

describe('score precision', () => {
  const fuzzyEntry = party({ refId: 'Q-1', names: [{ value: 'Ismail Quorin Haldevan', quality: 'PRIMARY' }] });
  const fuzzySubject = subject({ lastName: undefined, firstName: 'Ismael Quorrin Haldevane' });

  it('returns hit scores already rounded to 4 decimals (the same value the database stores)', () => {
    const [h] = runScreening(input({ subject: fuzzySubject, un: un(fuzzyEntry) }));
    expect(h.matchType).toBe('NAME_FUZZY');
    expect(h.score).toBe(0.9714); // эх оноо 0.9714285714285713
    expect(Number(h.score.toFixed(4))).toBe(h.score);
  });

  it('compares the threshold against the same rounded value', () => {
    // эх оноо 8/13 = 0.615384…, 4 орноор 0.6154: босго 0.6154 үед hit гарна (өмнө нь 0.61538 < 0.6154 тул алдагддаг байсан).
    // Нэр нь o, e үсэггүй: эгшгийн хувилбар оноог өөрчлөхгүй.
    const s = subject({ lastName: undefined, firstName: 'Ali Hamid' });
    const entry = party({ refId: 'Q-2', names: [{ value: 'Ali Hamid Karim', quality: 'PRIMARY' }] });
    const p = policy({ reviewThreshold: 0.6154, strongThreshold: 0.95 });
    const hits = runScreening(input({ subject: s, policy: p, un: un(entry) }));
    expect(hits.map((h) => h.score)).toEqual([0.6154]);
    expect(runScreening(input({ subject: s, policy: policy({ reviewThreshold: 0.6155, strongThreshold: 0.95 }), un: un(entry) }))).toEqual([]);
  });

  // review [35]: `nameHit.score === 1` → `>= 0.99` болгоход тест ногоон хэвээр байсан
  it('labels a score in [0.99, 1) NAME_FUZZY: only identical normalised names are NAME_EXACT', () => {
    const long = 'Ganbold Batbayar Erdenebat Dorjsuren Tsetsegmaa Munkhbat Sukhbaatar';
    const s = subject({ lastName: undefined, firstName: long });
    const variants: [string, number][] = [['Ganbold Batbayar Erdenebat Dorjsuren Tsetsegmaas Munkhbat Sukhbaatar', 0.9966], ['Ganbold Batbayar Erdenebat Dorjsuren Tsetsegmaa Munkhbat Sukhbaatas', 0.993]];
    for (const [variant, score] of variants) {
      const [h] = runScreening(input({ subject: s, un: un(party({ refId: 'Q-4', names: [{ value: variant, quality: 'PRIMARY' }] })) }));
      expect(h.score).toBe(score);
      expect(h.score).toBeGreaterThanOrEqual(0.99);
      expect(h.matchType).toBe('NAME_FUZZY');
    }
    const [exact] = runScreening(input({ subject: s, un: un(party({ refId: 'Q-5', names: [{ value: long.toUpperCase(), quality: 'PRIMARY' }] })) }));
    expect(exact).toMatchObject({ matchType: 'NAME_EXACT', score: 1 });
  });

  // Mutation шалгалт: `>= 0.9999` болгоход тест ногоон хэвээр байсан (4 орноор хуульчлахад 1-ээс бага оноо 0.9999 хүртэл ойртоно)
  it('labels even the highest non-exact score (0.9999) NAME_FUZZY', () => {
    // 3000 тэмдэгттэй хоёр токений сүүлчийн хоёр тэмдэгтийг сольсон: Jaro-Winkler 0.99993…, quantiseScore-оор 0.9999.
    // AmlSubject-ийн 200 тэмдэгтийн хязгаарт ийм оноо хүрэхгүй тул схемээр дамжуулалгүй шууд бүтээнэ (хуульчилсан хэмжээ энд л шалгагдана).
    const letters = 'bcdfglmnprstv';
    const token = (shift: number) => Array.from({ length: 3000 }, (_, i) => letters[(i * 5 + shift) % 13]).join('');
    const swapEnd = (word: string) => word.slice(0, -2) + word[word.length - 1] + word[word.length - 2];
    const [a, b] = [token(0), token(3)];
    const s: AmlSubject = { ...subject({ lastName: undefined }), firstName: `${a} ${b}` };
    const [h] = runScreening(input({ subject: s, un: un(party({ refId: 'Q-6', names: [{ value: `${a} ${swapEnd(b)}`, quality: 'PRIMARY' }] })) }));
    expect(h.score).toBe(0.9999);
    expect(h.matchType).toBe('NAME_FUZZY');
  });

  it('keeps NAME_EXACT for score 1 only', () => {
    const exact = runScreening(input({ un: un(party({ refId: 'Q-3' })) }));
    expect(exact[0]).toMatchObject({ matchType: 'NAME_EXACT', score: 1 });
    const hits = runScreening(input({ subject: fuzzySubject, un: un(fuzzyEntry) }));
    expect(hits[0].score).toBeLessThan(1);
    expect(hits[0].matchType).toBe('NAME_FUZZY');
  });
});

describe('performance (DoS)', () => {
  // AmlSubject-ийн хязгаарт хүрсэн хамгийн том субъект: нэр бүр ≤ 12 үг, нийт 48 үг. овог+нэр нэг хувилбар (24 үг) болдог.
  const words = (n: number, offset: number) =>
    Array.from({ length: n }, (_, i) => `${String.fromCharCode(97 + ((i + offset) % 26))}${i % 3 === 0 ? String.fromCharCode(97 + (((i + offset) * 7) % 26)) : ''}`).join(' ');
  const maxSubject = () => AmlSubject.parse({
    subjectType: 'INDIVIDUAL', registerNo: REGISTER, lastName: words(6, 0), firstName: words(6, 3),
    aliases: [words(12, 5), words(12, 9), words(12, 11)],
  });

  it('screens a maximum-size subject against the fixture list well under a second', () => {
    const s = maxSubject();
    const start = performance.now();
    runScreening(input({ subject: s, un: UN_SC_FIXTURE }));
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('screens a maximum-size subject (48 words) against a 1,000-entry list (5 names each) in a bounded time', () => {
    const entries: UnSanctionedParty[] = Array.from({ length: 1000 }, (_, k) => party({
      refId: `BIG-${k}`, type: k % 4 === 0 ? 'ENTITY' : 'INDIVIDUAL',
      names: Array.from({ length: 5 }, (_, n) => ({ value: `Name${k}x${n} Fam${(k * 7 + n) % 97} Third${(k + n) % 31}`, quality: 'PRIMARY' as const })),
    }));
    const snapshot = un(...entries);
    const s = maxSubject();
    const start = performance.now();
    const hits = runScreening(input({ subject: s, un: snapshot }));
    expect(performance.now() - start).toBeLessThan(3000);
    expect(hits).toEqual([]);
  });

  it('rejects the 4.3 KB body of the DoS finding (≈100 one-letter words per name) before it reaches the engine', () => {
    const hundred = Array.from({ length: 100 }, () => 'a').join(' ');
    const body = { subjectType: 'INDIVIDUAL', registerNo: REGISTER, lastName: hundred, firstName: hundred, aliases: Array.from({ length: 19 }, () => hundred) };
    expect(AmlSubject.safeParse(body).success).toBe(false);
    // 12 үг хүртэлх нэр багтана
    expect(AmlSubject.safeParse({ subjectType: 'INDIVIDUAL', registerNo: REGISTER, firstName: Array.from({ length: 12 }, () => 'a').join(' ') }).success).toBe(true);
  });

  it('returns the same hits for repeated screenings of the same snapshot (name preparation is cached per list entry)', () => {
    const snapshot = un(party({ refId: 'C-1' }), party({ refId: 'C-2', names: [{ value: 'Ismail Quorin Haldevan', quality: 'PRIMARY' }] }));
    const first = runScreening(input({ un: snapshot }));
    expect(runScreening(input({ un: snapshot }))).toEqual(first);
    // нэрийг in-place өөрчилбөл кэш хуучирсан утга өгөхгүй
    snapshot.entries[0].names[0].value = 'Completely Different Name';
    expect(runScreening(input({ un: snapshot })).map((h) => h.entryRef)).toEqual([]);
  });
});
