import { describe, expect, it } from 'vitest';
import { isoAlpha2FromCountryName } from './country-codes';
import { parseUnConsolidatedXml } from './un-consolidated.parser';

// НҮБ-ын нэгдсэн жагсаалтын XML (scsanctions.un.org). БҮТЭЦ нь бодит нийтийн файлаас баталгаажсан (CONSOLIDATED_LIST[dateGenerated] / INDIVIDUALS / ENTITIES,
// QUALITY = Good | Low | a.k.a. | f.k.a., TYPE_OF_DATE = EXACT | APPROXIMATELY | BETWEEN); ӨГӨГДӨЛ нь бүхэлдээ синтетик.
const doc = (body: string, attrs = 'dateGenerated="2026-11-19T00:00:03.388Z"') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<CONSOLIDATED_LIST ${attrs}>${body}</CONSOLIDATED_LIST>`;

const FULL_INDIVIDUAL = `
<INDIVIDUAL>
  <DATAID>1</DATAID><VERSIONNUM>1</VERSIONNUM>
  <FIRST_NAME>ALPHA</FIRST_NAME><SECOND_NAME>BRAVO</SECOND_NAME><THIRD_NAME>CHARLIE</THIRD_NAME><FOURTH_NAME>DELTA</FOURTH_NAME>
  <UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE><REFERENCE_NUMBER>QDi.001</REFERENCE_NUMBER><LISTED_ON>2001-10-08</LISTED_ON>
  <NAME_ORIGINAL_SCRIPT>АЛЬФА БРАВО</NAME_ORIGINAL_SCRIPT>
  <COMMENTS1>Synthetic fixture &amp; test remark</COMMENTS1>
  <NATIONALITY><VALUE>Russian Federation</VALUE><VALUE>Iran (Islamic Republic of)</VALUE><VALUE>na</VALUE></NATIONALITY>
  <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Al Pha</ALIAS_NAME></INDIVIDUAL_ALIAS>
  <INDIVIDUAL_ALIAS><QUALITY>Low</QUALITY><ALIAS_NAME>Alf</ALIAS_NAME></INDIVIDUAL_ALIAS>
  <INDIVIDUAL_ALIAS><QUALITY>a.k.a.</QUALITY><ALIAS_NAME>Alpha B</ALIAS_NAME></INDIVIDUAL_ALIAS>
  <INDIVIDUAL_ALIAS><QUALITY>f.k.a.</QUALITY><ALIAS_NAME>Old Alpha</ALIAS_NAME></INDIVIDUAL_ALIAS>
  <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME/></INDIVIDUAL_ALIAS>
  <INDIVIDUAL_ALIAS><QUALITY>Low</QUALITY><ALIAS_NAME>ALPHA BRAVO CHARLIE DELTA</ALIAS_NAME></INDIVIDUAL_ALIAS>
  <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><DATE>1978-04-28</DATE></INDIVIDUAL_DATE_OF_BIRTH>
  <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>APPROXIMATELY</TYPE_OF_DATE><YEAR>1980</YEAR></INDIVIDUAL_DATE_OF_BIRTH>
  <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>BETWEEN</TYPE_OF_DATE><FROM_YEAR>1973</FROM_YEAR><TO_YEAR>1975</TO_YEAR></INDIVIDUAL_DATE_OF_BIRTH>
  <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>Passport</TYPE_OF_DOCUMENT><NUMBER>00123456</NUMBER><ISSUING_COUNTRY>Russian Federation</ISSUING_COUNTRY></INDIVIDUAL_DOCUMENT>
  <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>National Identification Number</TYPE_OF_DOCUMENT><TYPE_OF_DOCUMENT2>FARDC ID</TYPE_OF_DOCUMENT2><NUMBER>1-78-09</NUMBER></INDIVIDUAL_DOCUMENT>
  <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>Passport</TYPE_OF_DOCUMENT><NUMBER></NUMBER></INDIVIDUAL_DOCUMENT>
</INDIVIDUAL>`;

const ENTITY = `
<ENTITY>
  <DATAID>9</DATAID><FIRST_NAME>FIXTURE CORP &amp; SONS</FIRST_NAME><UN_LIST_TYPE>DPRK</UN_LIST_TYPE><REFERENCE_NUMBER>KPe.001</REFERENCE_NUMBER><LISTED_ON>2016-03-02</LISTED_ON>
  <ENTITY_ALIAS><QUALITY>a.k.a.</QUALITY><ALIAS_NAME>Fixture Co</ALIAS_NAME></ENTITY_ALIAS>
  <ENTITY_ADDRESS><COUNTRY>Democratic People's Republic of Korea</COUNTRY></ENTITY_ADDRESS>
</ENTITY>`;

const MINIMAL = (ref: string, name = 'MINIMAL') => `<INDIVIDUAL><FIRST_NAME>${name}</FIRST_NAME><UN_LIST_TYPE>Taliban</UN_LIST_TYPE><REFERENCE_NUMBER>${ref}</REFERENCE_NUMBER><LISTED_ON>2020-01-01</LISTED_ON></INDIVIDUAL>`;
const full = doc(`<INDIVIDUALS>${FULL_INDIVIDUAL}</INDIVIDUALS><ENTITIES>${ENTITY}</ENTITIES>`);

describe('parseUnConsolidatedXml — хувь хүн', () => {
  const snap = parseUnConsolidatedXml(full);
  const person = snap.entries.find((e) => e.refId === 'QDi.001')!;

  it('хувилбар = dateGenerated; publishedAt = ижил агшин (ISO)', () => {
    expect(snap.version).toBe('2026-11-19T00:00:03.388Z');
    expect(snap.publishedAt).toBe('2026-11-19T00:00:03.388Z');
    expect(snap.entries).toHaveLength(2);
  });

  it('нэр: names[0] = PRIMARY (4 хэсгийг нэгтгэсэн); alias-ууд баримтын дарааллаар; анхны бичвэрийн нэр GOOD_ALIAS', () => {
    expect(person.names).toEqual([
      { value: 'ALPHA BRAVO CHARLIE DELTA', quality: 'PRIMARY' },
      { value: 'Al Pha', quality: 'GOOD_ALIAS' },
      { value: 'Alf', quality: 'LOW_ALIAS' },
      { value: 'Alpha B', quality: 'GOOD_ALIAS' }, // a.k.a. → GOOD (илүү олон дохио өгөх нь аюулгүй тал)
      { value: 'Old Alpha', quality: 'GOOD_ALIAS' }, // f.k.a. → GOOD
      { value: 'АЛЬФА БРАВО', quality: 'GOOD_ALIAS' },
    ]);
  });

  it('хоосон alias болон PRIMARY-тэй ижил alias-ийг нэмэхгүй (давхардалгүй)', () => {
    expect(person.names.filter((n) => n.value === 'ALPHA BRAVO CHARLIE DELTA')).toHaveLength(1);
    expect(person.names.some((n) => n.value === '')).toBe(false);
  });

  it('төрсөн огноо: EXACT огноо → YYYY-MM-DD; жил → YYYY; BETWEEN → жил бүр', () => {
    expect(person.datesOfBirth).toEqual(['1978-04-28', '1980', '1973', '1974', '1975']);
  });

  it('иргэншил: улсын нэр → ISO alpha-2; танигдахгүй ("na") хасагдана', () => {
    expect(person.nationalities).toEqual(['RU', 'IR']);
  });

  it('бичиг баримт: төрөл (TYPE_OF_DOCUMENT2 давуу), дугаар (тэгээр эхэлсэн хэвээр), олгосон улс; дугааргүй мөр хасагдана', () => {
    expect(person.identifiers).toEqual([
      { type: 'Passport', value: '00123456', country: 'RU' },
      { type: 'FARDC ID', value: '1-78-09' },
    ]);
  });

  it('хөтөлбөр, бүртгэсэн огноо, тайлбар (XML entity задарсан)', () => {
    expect(person).toMatchObject({ type: 'INDIVIDUAL', programme: 'Al-Qaida', listedOn: '2001-10-08', remarks: 'Synthetic fixture & test remark' });
  });
});

describe('parseUnConsolidatedXml — байгууллага', () => {
  const entity = parseUnConsolidatedXml(full).entries.find((e) => e.refId === 'KPe.001')!;
  it('нэр (entity задарсан), alias, хоосон төрсөн огноо / иргэншил / бичиг баримт', () => {
    expect(entity).toMatchObject({ type: 'ENTITY', programme: 'DPRK', listedOn: '2016-03-02', datesOfBirth: [], nationalities: [], identifiers: [] });
    expect(entity.names).toEqual([{ value: 'FIXTURE CORP & SONS', quality: 'PRIMARY' }, { value: 'Fixture Co', quality: 'GOOD_ALIAS' }]);
    expect(entity.remarks).toBeUndefined();
  });
});

describe('parseUnConsolidatedXml — хэлбэрийн хувилбар', () => {
  it('ганц INDIVIDUAL / ганц alias (массив биш) мөн зөв задарна', () => {
    const one = doc(`<INDIVIDUALS><INDIVIDUAL><FIRST_NAME>SOLO</FIRST_NAME><UN_LIST_TYPE>Libya</UN_LIST_TYPE><REFERENCE_NUMBER>LYi.001</REFERENCE_NUMBER><LISTED_ON>2011-02-26</LISTED_ON><INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Solo X</ALIAS_NAME></INDIVIDUAL_ALIAS></INDIVIDUAL></INDIVIDUALS>`);
    const [p] = parseUnConsolidatedXml(one).entries;
    expect(p!.names.map((n) => n.value)).toEqual(['SOLO', 'Solo X']);
  });

  it('зөвхөн ENTITIES (INDIVIDUALS байхгүй) эсвэл зөвхөн INDIVIDUALS', () => {
    expect(parseUnConsolidatedXml(doc(`<ENTITIES>${ENTITY}</ENTITIES>`)).entries).toHaveLength(1);
    expect(parseUnConsolidatedXml(doc(`<INDIVIDUALS>${MINIMAL('A.1')}</INDIVIDUALS>`)).entries).toHaveLength(1);
  });

  it('BETWEEN буруу / хэт том муж (from > to эсвэл 30-аас олон жил) → хасна, бусад огноо хэвээр', () => {
    const wide = doc(`<INDIVIDUALS><INDIVIDUAL><FIRST_NAME>X</FIRST_NAME><UN_LIST_TYPE>T</UN_LIST_TYPE><REFERENCE_NUMBER>R.1</REFERENCE_NUMBER><LISTED_ON>2020-01-01</LISTED_ON>
      <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>BETWEEN</TYPE_OF_DATE><FROM_YEAR>1990</FROM_YEAR><TO_YEAR>1980</TO_YEAR></INDIVIDUAL_DATE_OF_BIRTH>
      <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>BETWEEN</TYPE_OF_DATE><FROM_YEAR>1900</FROM_YEAR><TO_YEAR>2000</TO_YEAR></INDIVIDUAL_DATE_OF_BIRTH>
      <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><YEAR>1975</YEAR></INDIVIDUAL_DATE_OF_BIRTH></INDIVIDUAL></INDIVIDUALS>`);
    expect(parseUnConsolidatedXml(wide).entries[0]!.datesOfBirth).toEqual(['1975']);
  });
});

describe('parseUnConsolidatedXml — татгалзах (fail closed: нэг буруу бичлэг бүх жагсаалтыг чимээгүй богиносгохгүй)', () => {
  it.each([
    ['XML биш / өөр root', '<html><body/></html>', /CONSOLIDATED_LIST/],
    ['dateGenerated байхгүй', doc(`<INDIVIDUALS>${MINIMAL('A.1')}</INDIVIDUALS>`, ''), /dateGenerated/],
    ['dateGenerated буруу', doc(`<INDIVIDUALS>${MINIMAL('A.1')}</INDIVIDUALS>`, 'dateGenerated="yesterday"'), /dateGenerated/],
    ['DTD / ENTITY тунхагласан (XXE, entity-ийн тэсрэлт)', `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><CONSOLIDATED_LIST dateGenerated="2026-11-19T00:00:03.388Z"><INDIVIDUALS>${MINIMAL('A.1')}</INDIVIDUALS></CONSOLIDATED_LIST>`, /DTD/],
    ['ганц ч бичлэггүй', doc('<INDIVIDUALS></INDIVIDUALS><ENTITIES></ENTITIES>'), /no entries/],
    ['нэргүй бичлэг', doc('<INDIVIDUALS><INDIVIDUAL><UN_LIST_TYPE>T</UN_LIST_TYPE><REFERENCE_NUMBER>R.9</REFERENCE_NUMBER></INDIVIDUAL></INDIVIDUALS>'), /name/],
    ['REFERENCE_NUMBER-гүй бичлэг', doc('<INDIVIDUALS><INDIVIDUAL><FIRST_NAME>NOREF</FIRST_NAME></INDIVIDUAL></INDIVIDUALS>'), /REFERENCE_NUMBER/],
    ['давхардсан REFERENCE_NUMBER', doc(`<INDIVIDUALS>${MINIMAL('A.1', 'ONE')}${MINIMAL('A.1', 'TWO')}</INDIVIDUALS>`), /duplicate/i],
  ])('%s → алдаа', (_label, xml, pattern) => {
    expect(() => parseUnConsolidatedXml(xml)).toThrow(pattern);
  });

  it('алдааны мессеж бичлэгийн нэр, агуулгыг оруулахгүй (зөвхөн шалтгаан)', () => {
    try {
      parseUnConsolidatedXml(doc('<INDIVIDUALS><INDIVIDUAL><FIRST_NAME>   </FIRST_NAME><REFERENCE_NUMBER>SECRET.REF</REFERENCE_NUMBER></INDIVIDUAL></INDIVIDUALS>'));
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).not.toContain('SECRET.REF');
    }
  });
});

describe('isoAlpha2FromCountryName', () => {
  it.each([
    ['Russian Federation', 'RU'], ['Iran (Islamic Republic of)', 'IR'], ["Democratic People's Republic of Korea", 'KP'], ['Democratic Republic of the Congo', 'CD'],
    ['United Kingdom of Great Britain and Northern Ireland', 'GB'], ['United States of America', 'US'], ['Syrian Arab Republic', 'SY'],
    ['United Republic of Tanzania', 'TZ'], ['Trinidad and Tobago', 'TT'], ['Bosnia and Herzegovina', 'BA'], ['State of Palestine', 'PS'],
    ['Afghanistan', 'AF'], ['Somalia', 'SO'], ['Mongolia', 'MN'], ['  libya  ', 'LY'], ['SOMALIA', 'SO'],
  ])('%j → %s (бодит UN файлд байсан нэрс + энгийн нэрс)', (name, code) => {
    expect(isoAlpha2FromCountryName(name)).toBe(code);
  });
  it.each([['na'], [''], ['   '], ['Atlantis'], ['former Soviet Union'], [undefined]])('танигдахгүй %j → null (зохиож код өгөхгүй)', (name) => {
    expect(isoAlpha2FromCountryName(name as string)).toBeNull();
  });

  // 2026-11-19-ний бодит файлд (NATIONALITY + ISSUING_COUNTRY) байсан бүх нэр. ICU-ийн нэр солигдвол энд эхэлж унана.
  const REAL_UN_NAMES = ['Afghanistan', 'Algeria', 'Bosnia and Herzegovina', 'Central African Republic', 'Chad', 'China', 'Colombia', 'Congo', "Democratic People's Republic of Korea", 'Democratic Republic of the Congo', 'Egypt', 'Eritrea', 'Ethiopia', 'France', 'Georgia', 'Germany', 'Guinea-Bissau', 'Haiti', 'India', 'Indonesia', 'Iran (Islamic Republic of)', 'Iraq', 'Italy', 'Jordan', 'Kenya', 'Kuwait', 'Libya', 'Malaysia', 'Mali', 'Mauritania', 'Morocco', 'Nigeria', 'Norway', 'Oman', 'Pakistan', 'Philippines', 'Qatar', 'Russian Federation', 'Rwanda', 'Saudi Arabia', 'Senegal', 'Somalia', 'South Sudan', 'Spain', 'State of Palestine', 'Sudan', 'Sweden', 'Syrian Arab Republic', 'Tajikistan', 'Trinidad and Tobago', 'Tunisia', 'Türkiye', 'Uganda', 'United Arab Emirates', 'United Kingdom of Great Britain and Northern Ireland', 'United Republic of Tanzania', 'United States of America', 'Uzbekistan', 'Yemen', 'Zambia'];
  it('бодит UN файлын бүх улсын нэр танигдана (хоёр үсэгт код)', () => {
    const unmapped = REAL_UN_NAMES.filter((n) => !/^[A-Z]{2}$/.test(isoAlpha2FromCountryName(n) ?? ''));
    expect(unmapped).toEqual([]);
  });
  it.each([['Congo', 'CG'], ['Türkiye', 'TR'], ['Turkey', 'TR'], ['Georgia', 'GE'], ['Bosnia & Herzegovina', 'BA']])('нэгтгэсэн хайлт: %j → %s', (name, code) => {
    expect(isoAlpha2FromCountryName(name)).toBe(code);
  });
});
