import type { AmlHit, AmlPolicy, AmlSubject, FatfCategory, HitMatchType, HitSeverity, ScreeningList } from '@los/contracts';
import { foldRegisterNo, maskRegisterNoStrict } from '@los/database';
import type { FatfSnapshot } from '../../../integrations/fatf/fatf.client';
import type { UnPartyIdentifier, UnPartyName, UnSanctionedParty, UnSanctionsSnapshot } from '../../../integrations/un-sc/un-sc.client';
import type { BlacklistProjection } from '../aml.ports';
import { bestPreparedMatch, prepareName, type PreparedName } from '../matching';
import { subjectNames, yearOf } from './subject-names';

/** AmlSubject.countries хоосон үед ашиглах анхдагч улс (aml.service-тэй ижил). */
const DEFAULT_COUNTRY = 'MN';
const ISO2 = /^[A-Za-z]{2}$/;
// Монгол регистрийн хэлбэр (normalizeRegisterNo-ийн дараа): хувь хүн = 2 кирилл үсэг + 8 цифр, ААН = яг 7 цифр. Зөвхөн ийм дугаар
// гадаад иргэний бичиг баримттай (паспортын 7-8 цифр) санамсаргүй давхцаж болох тул улсын шүүлтүүр зөвхөн ЭНД хамаарна.
const MONGOLIAN_REGISTER = /^(?:\p{Script=Cyrillic}{2}\d{8}|\d{7})$/u;
// Тоон токен зөрсөн нэрийг review босгоос ДООД гаргах зөрүү (босго нь бодлогоос, оноо 4 орноор хуульчлагддаг).
const DIGIT_CAP_MARGIN = 1e-4;

/**
 * Hit-ийн оноог 4 орон хүртэл хуульчилна (aml_hit.score Decimal(5,4)-тэй ижил): босгоор харьцуулах, хадгалах, хариу өгөх нь
 * НЭГ утга дээр хийгдэнэ (POST /aml/screen ба дараа нь уншсан утга зөрөхгүй). 1-ээс бага бодит оноо 1.0000 болж NAME_EXACT гэж
 * андуурагдахгүйн тулд 0.9999-д хязгаарлана.
 */
export function quantiseScore(raw: number): number {
  const rounded = Math.round(raw * 1e4) / 1e4;
  return raw < 1 ? Math.min(rounded, 0.9999) : rounded;
}

/** Persist хийхээс өмнөх hit (id, status, review талбарууд service дээр оноогдоно). */
export type HitCandidate = Pick<AmlHit, 'list' | 'matchType' | 'score' | 'severity' | 'entryRef' | 'entryName' | 'matchedValue' | 'details' | 'listVersion'>;

export interface EngineInput {
  subject: AmlSubject;
  policy: AmlPolicy;
  lists: readonly ScreeningList[];
  un?: UnSanctionsSnapshot;
  fatf?: FatfSnapshot;
  /** Регистрийн hash-аар аль хэдийн шүүгдсэн идэвхтэй бүртгэлүүд. */
  blacklist?: BlacklistProjection[];
}

type DobEvidence = 'MATCH' | 'MISMATCH' | 'UNKNOWN';

/** Цэвэр функц: жагсаалтын snapshot + субъект → hit-үүд (FR-3.4). I/O, цаг, санамсаргүй утга байхгүй. */
export function runScreening(input: EngineInput): HitCandidate[] {
  const hits: HitCandidate[] = [];
  if (input.lists.includes('UN_SC') && input.un) hits.push(...matchUn(input.subject, input.policy, input.un));
  if (input.lists.includes('FATF') && input.fatf) hits.push(...matchFatf(input.subject, input.policy, input.fatf));
  if (input.lists.includes('INTERNAL_BLACKLIST') && input.blacklist) hits.push(...matchBlacklist(input.policy, input.blacklist));
  return hits;
}

const sanctionsSeverity = (p: AmlPolicy): HitSeverity => (p.blockOnSanctionsHit ? 'BLOCKING' : 'WARNING');

function dobEvidence(subjectBirth: string | undefined, entryDates: string[]): DobEvidence {
  const subjectYear = subjectBirth ? yearOf(subjectBirth) : null;
  const entryYears = entryDates.map(yearOf).filter((y): y is number => y !== null);
  if (subjectYear === null || entryYears.length === 0) return 'UNKNOWN';
  return entryYears.includes(subjectYear) ? 'MATCH' : 'MISMATCH';
}

interface NameHit { score: number; matchedName: string; subjectName: string }

// UN snapshot нь screening хооронд хуваалцагдана (WatchlistService cache) тул жагсаалтын нэр бүрийн нормчлолыг нэг удаа хийнэ.
// Түлхүүр = нэрийн объект, утга өөрчлөгдсөн бол (in-place) дахин бэлтгэнэ. Цэвэр memo: үр дүн оролтоос л хамаарна.
interface CachedName { value: string; prepared: PreparedName }
const preparedEntryNames = { person: new WeakMap<UnPartyName, CachedName>(), entity: new WeakMap<UnPartyName, CachedName>() };
function preparedEntryName(name: UnPartyName, legalEntity: boolean): PreparedName {
  const cache = legalEntity ? preparedEntryNames.entity : preparedEntryNames.person;
  const hit = cache.get(name);
  if (hit && hit.value === name.value) return hit.prepared;
  const prepared = prepareName(name.value, { legalEntity });
  cache.set(name, { value: name.value, prepared });
  return prepared;
}

// variants нь screening бүрт НЭГ удаа бэлтгэгдсэн (нормчлол, токенчлол) субъектийн нэрс; UN-ийн нэр тутамд дахин нормчлохгүй.
function bestNameHit(entry: UnSanctionedParty, variants: readonly PreparedName[], policy: AmlPolicy, dob: DobEvidence): NameHit | null {
  let best: NameHit | null = null;
  const legalEntity = entry.type === 'ENTITY';
  // Тоон токен зөрсөн нэр (Group 1 ~ Group 2) бодлогын reviewThreshold-оос доош оноотой байх ёстой: хоёр босго (review, strong) хоёуланд нь.
  const scoreOptions = { digitConflictCap: Math.max(policy.reviewThreshold - DIGIT_CAP_MARGIN, 0) };
  for (const name of entry.names) {
    const m = bestPreparedMatch(variants, [preparedEntryName(name, legalEntity)], scoreOptions);
    if (!m) continue;
    const score = quantiseScore(m.score);
    // Чанар муутай alias, төрсөн он зөрсөн үед зөвхөн хүчтэй тохирол hit болно.
    const min = name.quality === 'LOW_ALIAS' || dob === 'MISMATCH' ? policy.strongThreshold : policy.reviewThreshold;
    if (score >= min && (!best || score > best.score)) best = { score, matchedName: name.value, subjectName: m.subjectName };
  }
  return best;
}

// Тухайн улсын иргэний бичиг баримт зөвхөн тухайн улстай холбоотой субъектэд хамаарна (гадаад паспортын дугаар монгол регистртэй
// давхцахгүй) — ГЭХДЭЭ зөвхөн субъектийн регистр Монгол хэлбэртэй (MONGOLIAN_REGISTER) үед. Бусад хэлбэрийн регистр/паспорт
// (FX0012345) нь улсын жагсаалтаар шүүгдэхгүй: aml.service нь улсыг үргэлж ['MN'] болгон нөхдөг (origination-д иргэншил байхгүй) тул
// engine "улс тодорхойгүй"-г "Монгол"-оос ялгаж чадахгүй, шүүвэл НҮБ-ын гадаад баримт бүр хэзээ ч таарахгүй (recall). Улсгүй эсвэл
// ISO alpha-2 биш утгатай баримтыг ТАЙЛБАРЛАЖ ЧАДАХГҮЙ тул Монгол хэлбэрт ч харьцуулна.
function identifierApplies(identifier: UnPartyIdentifier, countries: ReadonlySet<string>, gateByCountry: boolean): boolean {
  if (!gateByCountry) return true;
  const country = identifier.country?.trim();
  return !country || !ISO2.test(country) || countries.has(country.toUpperCase());
}

function matchUn(subject: AmlSubject, policy: AmlPolicy, snapshot: UnSanctionsSnapshot): HitCandidate[] {
  const registerNo = foldRegisterNo(subject.registerNo);
  const countries = new Set((subject.countries.length ? subject.countries : [DEFAULT_COUNTRY]).map((c) => c.toUpperCase()));
  const gateByCountry = MONGOLIAN_REGISTER.test(registerNo);
  const legalEntity = subject.subjectType === 'LEGAL_ENTITY';
  const variants = subjectNames(subject).map((n) => prepareName(n, { legalEntity }));
  const out: HitCandidate[] = [];

  for (const entry of snapshot.entries) {
    // Хоосон нормчилсон регистр ('--') хоосон нормчилсон баримттай хэзээ ч таарахгүй (registerNo !== '' ⇒ нөгөө тал ч хоосон биш).
    const idMatch = registerNo === ''
      ? undefined
      : entry.identifiers.find((i) => identifierApplies(i, countries, gateByCountry) && foldRegisterNo(i.value) === registerNo);
    const dob = entry.type === 'INDIVIDUAL' ? dobEvidence(subject.birthDate, entry.datesOfBirth) : 'UNKNOWN';
    const sameKind = (subject.subjectType === 'INDIVIDUAL') === (entry.type === 'INDIVIDUAL');
    const nameHit = sameKind ? bestNameHit(entry, variants, policy, dob) : null;
    const found = idMatch
      ? { matchType: 'REGISTER_EXACT' as HitMatchType, score: 1, matchedValue: maskRegisterNoStrict(subject.registerNo) }
      : nameHit
        ? { matchType: (nameHit.score === 1 ? 'NAME_EXACT' : 'NAME_FUZZY') as HitMatchType, score: nameHit.score, matchedValue: nameHit.matchedName }
        : null;
    if (!found) continue;

    out.push({
      list: 'UN_SC',
      ...found,
      severity: sanctionsSeverity(policy),
      entryRef: entry.refId,
      entryName: entry.names[0]?.value ?? entry.refId,
      details: {
        programme: entry.programme,
        listedOn: entry.listedOn,
        partyType: entry.type,
        matchedName: nameHit?.matchedName ?? null,
        subjectName: nameHit?.subjectName ?? null,
        dateOfBirth: dob,
        nationalities: entry.nationalities,
        ...(idMatch ? { identifierType: idMatch.type } : {}),
      },
      listVersion: snapshot.version,
    });
  }
  return out.sort((a, b) => b.score - a.score || a.entryRef.localeCompare(b.entryRef));
}

function matchFatf(subject: AmlSubject, policy: AmlPolicy, snapshot: FatfSnapshot): HitCandidate[] {
  const countries = new Set(subject.countries);
  return snapshot.entries
    .filter((e) => countries.has(e.countryCode))
    .map((e): HitCandidate => ({
      list: 'FATF',
      matchType: 'COUNTRY',
      score: 1,
      severity: severityForFatf(e.category, policy),
      entryRef: e.countryCode,
      entryName: e.countryName,
      matchedValue: e.countryCode,
      details: { category: e.category, listedOn: e.listedOn },
      listVersion: snapshot.version,
    }))
    .sort((a, b) => a.entryRef.localeCompare(b.entryRef));
}

function severityForFatf(category: FatfCategory, policy: AmlPolicy): HitSeverity {
  return category === 'CALL_FOR_ACTION' && policy.blockOnFatfCallForAction ? 'BLOCKING' : 'WARNING';
}

/** Дотоод хар жагсаалт: зөвхөн регистрийн яг тохирол (нэрээр тулгавал нийтлэг нэрэнд хэт олон хуурамч hit гарна). BR-9. */
function matchBlacklist(policy: AmlPolicy, rows: BlacklistProjection[]): HitCandidate[] {
  return rows
    .filter((r) => r.isActive)
    .map((r): HitCandidate => ({
      list: 'INTERNAL_BLACKLIST',
      matchType: 'REGISTER_EXACT',
      score: 1,
      severity: policy.blockOnInternalBlacklist ? 'BLOCKING' : 'WARNING',
      entryRef: r.id,
      entryName: r.name,
      matchedValue: null,
      details: { listType: r.listType, reasonCode: r.reasonCode, customerType: r.customerType },
      listVersion: 'live',
    }))
    .sort((a, b) => a.entryRef.localeCompare(b.entryRef));
}
