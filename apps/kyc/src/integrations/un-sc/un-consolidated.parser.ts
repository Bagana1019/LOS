// НҮБ-ын Аюулгүйн Зөвлөлийн нэгдсэн жагсаалтын XML (scsanctions.un.org) → UnSanctionsSnapshot. Цэвэр функц: I/O байхгүй.
// FAIL CLOSED: нэг бичлэг буруу бол БҮХ файлыг татгалзана — жагсаалтыг чимээгүй богиносгож, хориглогдсон этгээдийг "цэвэр" гэж үзэх нь буруу татах нь дээр.
// Алдааны мессеж зөвхөн шалтгааныг заана; бичлэгийн нэр, дугаар, агуулгыг оруулахгүй.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ExternalListError } from '../errors';
import { isoAlpha2FromCountryName } from './country-codes';
import type { UnNameQuality, UnPartyIdentifier, UnPartyName, UnPartyType, UnSanctionedParty, UnSanctionsSnapshot } from './un-sc.client';

type Rec = Record<string, unknown>;

const fail = (reason: string): never => { throw new ExternalListError('un-sc', reason); };
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const asRec = (v: unknown): Rec => (isRec(v) ? v : {});
const asArray = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
/** parseTagValue=false тул бүх утга string (тэгээр эхэлсэн бичиг баримтын дугаар "00123456" хэвээр үлдэнэ). */
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

// Ганц элемент ч гэсэн массив болгож нэгтгэнэ (XML → JS-ийн ганц/олон ялгааг арилгана).
const ARRAY_TAGS = new Set(['INDIVIDUAL', 'ENTITY', 'INDIVIDUAL_ALIAS', 'ENTITY_ALIAS', 'INDIVIDUAL_DATE_OF_BIRTH', 'INDIVIDUAL_DOCUMENT', 'VALUE']);
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true, processEntities: true, isArray: (name) => ARRAY_TAGS.has(name) });

const MAX_BIRTH_RANGE_YEARS = 30;

/** Good / a.k.a. / f.k.a. / үл мэдэгдэх → GOOD (илүү олон дохио өгөх нь аюулгүй тал); зөвхөн "Low" → LOW. */
const aliasQuality = (quality: string): UnNameQuality => (quality.toLowerCase() === 'low' ? 'LOW_ALIAS' : 'GOOD_ALIAS');

function collectNames(raw: Rec, aliasTag: string): UnPartyName[] {
  const primary = ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME'].map((k) => text(raw[k])).filter(Boolean).join(' ');
  if (!primary) fail('entry without a name');
  const names: UnPartyName[] = [];
  const index = new Map<string, number>();
  const add = (value: string, quality: UnNameQuality): void => {
    const v = value.replace(/\s+/g, ' ').trim();
    if (!v) return;
    const key = v.toLowerCase();
    const at = index.get(key);
    if (at === undefined) { index.set(key, names.length); names.push({ value: v, quality }); return; }
    // Давхардал: хүчтэй хувилбарыг үлдээнэ (Low → Good), харин PRIMARY-г хэзээ ч бууруулахгүй.
    if (names[at]!.quality === 'LOW_ALIAS' && quality !== 'LOW_ALIAS') names[at] = { value: names[at]!.value, quality };
  };
  add(primary, 'PRIMARY');
  for (const a of asArray(raw[aliasTag])) { const r = asRec(a); add(text(r.ALIAS_NAME), aliasQuality(text(r.QUALITY))); }
  add(text(raw.NAME_ORIGINAL_SCRIPT), 'GOOD_ALIAS');
  return names;
}

function isRealDate(ymd: string): boolean {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(ymd);
}

/** EXACT огноо → YYYY-MM-DD; жил → YYYY; BETWEEN → жил бүр (≤30 жилийн мужтай; буруу/хэт том муж хасагдана — хоёрдогч дохио). */
function collectBirthDates(raw: Rec): string[] {
  const out = new Set<string>();
  for (const d of asArray(raw.INDIVIDUAL_DATE_OF_BIRTH)) {
    const r = asRec(d);
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(text(r.DATE))?.[1];
    const year = text(r.YEAR);
    const from = Number(text(r.FROM_YEAR));
    const to = Number(text(r.TO_YEAR));
    if (date && isRealDate(date)) out.add(date);
    else if (/^\d{4}$/.test(year)) out.add(year);
    else if (/^\d{4}$/.test(text(r.FROM_YEAR)) && /^\d{4}$/.test(text(r.TO_YEAR)) && from <= to && to - from <= MAX_BIRTH_RANGE_YEARS) {
      for (let y = from; y <= to; y += 1) out.add(String(y));
    }
  }
  return [...out];
}

function collectNationalities(raw: Rec): string[] {
  const out = new Set<string>();
  for (const n of asArray(raw.NATIONALITY)) {
    for (const v of asArray(asRec(n).VALUE)) {
      const code = isoAlpha2FromCountryName(text(v));
      if (code) out.add(code);
    }
  }
  return [...out];
}

function collectIdentifiers(raw: Rec): UnPartyIdentifier[] {
  const out: UnPartyIdentifier[] = [];
  for (const d of asArray(raw.INDIVIDUAL_DOCUMENT)) {
    const r = asRec(d);
    const value = text(r.NUMBER);
    if (!value) continue;
    const type = text(r.TYPE_OF_DOCUMENT2) || text(r.TYPE_OF_DOCUMENT) || 'Unspecified';
    const country = isoAlpha2FromCountryName(text(r.ISSUING_COUNTRY));
    out.push(country ? { type, value, country } : { type, value });
  }
  return out;
}

function buildEntry(raw: Rec, type: UnPartyType, seen: Set<string>): UnSanctionedParty {
  const refId = text(raw.REFERENCE_NUMBER);
  if (!refId) fail('entry without REFERENCE_NUMBER');
  if (seen.has(refId)) fail('duplicate REFERENCE_NUMBER');
  seen.add(refId);
  const remarks = text(raw.COMMENTS1);
  return {
    refId,
    type,
    names: collectNames(raw, type === 'INDIVIDUAL' ? 'INDIVIDUAL_ALIAS' : 'ENTITY_ALIAS'),
    datesOfBirth: type === 'INDIVIDUAL' ? collectBirthDates(raw) : [],
    nationalities: collectNationalities(raw),
    identifiers: collectIdentifiers(raw),
    programme: text(raw.UN_LIST_TYPE) || 'UNSPECIFIED',
    listedOn: text(raw.LISTED_ON),
    ...(remarks ? { remarks } : {}),
  };
}

export function parseUnConsolidatedXml(input: string): UnSanctionsSnapshot {
  const source = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  // DTD / ENTITY тунхаглал (XXE, entity-ийн тэсрэлт) бодит файлд байдаггүй тул таниагүй бол татгалзана.
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail('DTD / ENTITY declarations are not allowed');
  if (XMLValidator.validate(source) !== true) fail('XML is not well-formed');
  const root = (xml.parse(source) as Rec).CONSOLIDATED_LIST;
  if (!isRec(root)) return fail('root element CONSOLIDATED_LIST not found');
  const generated = text(root['@_dateGenerated']);
  const ms = /^\d{4}-\d{2}-\d{2}T/.test(generated) ? Date.parse(generated) : Number.NaN;
  if (Number.isNaN(ms)) fail('dateGenerated is missing or invalid');

  const seen = new Set<string>();
  const entries = [
    ...asArray(asRec(root.INDIVIDUALS).INDIVIDUAL).map((e) => buildEntry(asRec(e), 'INDIVIDUAL', seen)),
    ...asArray(asRec(root.ENTITIES).ENTITY).map((e) => buildEntry(asRec(e), 'ENTITY', seen)),
  ];
  if (!entries.length) fail('list has no entries');
  return { version: generated, publishedAt: new Date(ms).toISOString(), entries };
}
