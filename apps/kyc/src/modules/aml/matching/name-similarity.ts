// Нэрийн ижилсэл (0..1): токен order-independent, зөв бичгийн хувилбарт тэсвэртэй, хэсэгчилсэн давхцалд хатуу.
// Босго (reviewThreshold 0.88, strongThreshold 0.95) нь AmlPolicy-д; энд зөвхөн оноо тооцно.
//
// Нэр бүр нэг удаа бэлтгэгдэнэ (prepareName): хэлбэр (үндсэн, паспортын ө→u, холимог бичгийн skeleton), токен, залгасан хэлбэр.
// Хос бүрийн оноо = хэлбэр хос бүрийн max(токен жинлэсэн оноо, залгасан хэлбэрийн оноо).
// Хэлбэрийн нэмэлт хувилбарууд (гурван "багц", эхний нь үндсэн): ААН-ийн хуулийн хэлбэр хассан/хасаагүй, эгшгийн хувилбар
// (o→u, e→a; зөвхөн хуулийн хэлбэр хассан үндсэн хэлбэрт). Багц бүрийг ЗӨВХӨН ижил багцтай нь харьцуулж, max авна: хассан нь
// хасаагүйг, эгшгийн хувилбар үндсэнийг орлохгүй. Хасаагүй хэлбэрт эгшгийн хувилбар нэмэхгүй: хуулийн хэлбэрийн токен (Co, Inc)
// залгах хилээр fold хийгдэж "Hossein Co Omar ~ Moussa Inc Omar"-ыг 0.909 болгодог байсан бөгөөд ашигтай тохиолдол олдоогүй.
import { editSimilarity } from './edit-distance';
import { jaroWinklerCodePoints } from './jaro-winkler';
import { isLegalFormToken, normalizeEntityName } from './legal-forms';
import { joinTokens, normalizeNameForms, tokenize, vowelVariant } from './normalize';

/** Токен хос энэ оноотой эсвэл түүнээс дээш бол л хоорондоо таарсанд тооцно. */
const PAIR_MIN = 0.8;
/** Залгасан хэлбэрийн ижилсэл энэ хэмжээнээс доош бол тоцохгүй (токен хостой ижил түвшин). */
const JOINED_MIN = 0.8;
/** Үгийн хил хязгаар шилжсэн нэрийн залгасан хэлбэрт зөвшөөрөх засвар (1 тэмдэгт). Инициалтай нэрэнд 0. */
const JOINED_MAX_EDITS = 1;
// Floating-point алдаа: JW("b", "bat") нь математикаар яг 0.8 боловч 0.7999…9 гарч босгыг алдах ёсгүй.
const SCORE_EPSILON = 1e-9;
/**
 * Үгийн хил хязгаар эсвэл үгийн дараалал (эргэлт)-аар л таарсан хосын оноо энүүнээс дээшгүй: нормчилсон нэр яг ижил биш тул
 * score 1 (NAME_EXACT) болохгүй, гэхдээ strongThreshold-оос дээгүүр (Abdul Rahman ~ Abdulrahman хүчтэй тохирол хэвээр).
 */
export const VARIANT_SCORE_CAP = 0.97;
/**
 * Эгшгийн хувилбараар (o→u, e→a) л таарсан хосын оноо энүүнээс дээшгүй. reviewThreshold (0.88)-оос дээш, strongThreshold (0.95)-оос
 * доош: Mohammed ~ Muhammad зэрэг маш олон хүний нэрийн бичлэгийн зөрүү review-д орно, харин төрсөн он зөрсөн үед (strong шаардана)
 * нийтлэг нэрийн хуурамч hit-ийг хаана.
 */
export const VOWEL_SCORE_CAP = 0.93;
/**
 * Хоёр талын бүх-цифртэй токенууд (88, 1, 2024) зөрсөн хосын оноо энэ хэмжээнээс дээшгүй (Group 1 ≠ Group 2). Анхдагч нь аль ч
 * бодит reviewThreshold-оос доогуур; screening engine нь бодлогын reviewThreshold-оос бага утга дамжуулна.
 */
export const DIGIT_CONFLICT_CAP = 0.5;
const DIGIT_TOKEN = /^\p{Nd}+$/u;

export interface NameOptions {
  /** ААН (ENTITY / LEGAL_ENTITY): ХХК, LLC, Ltd зэрэг хуулийн хэлбэрийн токеныг хасч, хасаагүй хувилбартай нь max авна. Хасаад юу ч үлдэхгүй бол хасахгүй. */
  legalEntity?: boolean;
}
export interface ScoreOptions {
  /** Цифр токен зөрсөн хосын оноог энэ хэмжээнээс дээш гаргахгүй (анхдагч DIGIT_CONFLICT_CAP). Engine нь reviewThreshold-оос бага өгнө. */
  digitConflictCap?: number;
}

interface Token {
  text: string;
  /** Код цэгүүд (Jaro-Winkler-д дахин задлахгүй). */
  chars: string[];
  /** Тэмдэгтүүдийн 31 битийн хэш-олонлог: хоёр токен нийтлэг тэмдэгтгүй бол AND нь 0. */
  mask: number;
}
export interface NameForm {
  normalized: string;
  tokens: Token[];
  /** Токенуудыг зайгүй залгасан (үгийн хил хязгаар хамаарахгүй) хэлбэр. */
  joinedChars: string[];
  joined: string;
  /** Залгасан хэлбэр дэх цифрүүд: ялгаатай бол өөр нэр (88 ≠ 99). */
  digits: string;
  /** Бүх-цифртэй токенууд эрэмбэлэгдсэн ('' = байхгүй). Хоёр тал хоёулаа цифр токентой, ялгаатай бол өөр нэр (Group 1 ≠ Group 2). */
  digitKey: string;
  /** Нэг үсэгт токен (инициал) байгаа эсэх. */
  hasInitial: boolean;
  /** Токенуудыг ээлжлэн эхлүүлсэн (циклээр) залгасан хэлбэрүүд. Зөвхөн хэрэгтэй үед тооцож хадгална. */
  rotations?: Rotations;
}
/**
 * Нэг удаа нормчилж, токенд хуваасан нэр. Харьцуулалт бүрт дахин нормчлохгүй.
 * sets = [үндсэн, эгшгийн хувилбар, хуулийн хэлбэр хасаагүй]; өөрчлөлтгүй багц нь өөр багцтай ИЖИЛ массив.
 * forms = sets[0] (ААН-д хуулийн хэлбэрийг хассан). Нормчилсон хэлбэр нь хоосон бол бүгд [].
 */
export interface PreparedName { name: string; forms: NameForm[]; sets: readonly (readonly NameForm[])[] }
/** PreparedName.sets дэх эгшгийн хувилбарын индекс. */
const VOWEL_SET = 1;
interface TokenPair { i: number; j: number; score: number; length: number }

function toToken(text: string, pool: Map<string, Token>): Token {
  let token = pool.get(text);
  if (!token) {
    const chars = [...text];
    let mask = 0;
    for (const ch of chars) mask |= 1 << (ch.codePointAt(0)! % 31);
    token = { text, chars, mask };
    pool.set(text, token);
  }
  return token;
}

function buildForm(words: readonly string[], pool: Map<string, Token>): NameForm {
  const joined = joinTokens(words);
  const tokens = words.map((word) => toToken(word, pool));
  return {
    normalized: words.join(' '),
    tokens,
    joined,
    joinedChars: [...joined],
    digits: joined.replace(/[^\p{Nd}]/gu, ''),
    digitKey: words.filter((word) => DIGIT_TOKEN.test(word)).sort().join(' '),
    hasInitial: tokens.some((token) => token.chars.length === 1),
  };
}

/** Үгийн жагсаалт бүрээс хэлбэр үүсгэнэ; ижил текстийг нэг л удаа (давхцахгүй). */
function formsOf(lists: readonly (readonly string[])[], pool: Map<string, Token>): NameForm[] {
  const seen = new Set<string>();
  const forms: NameForm[] = [];
  for (const words of lists) {
    const key = words.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    forms.push(buildForm(words, pool));
  }
  return forms;
}

const vowelWords = (words: readonly string[]): string[] => words.map(vowelVariant);

/**
 * Эгшгийн хувилбарын багц: ЗӨВХӨН үндсэн (эхний) хэлбэрийн o→u, e→a. Паспортын (ө→u), skeleton хэлбэрт эгшгийн хувилбар хийвэл хэлбэрийн
 * тоо хоёр дахин өсч (хос бүрт квадрат) ач холбогдол багатай. Эхний хэлбэр өөрчлөгдөхгүй (o, e байхгүй) бол ИЖИЛ багцыг буцаана.
 */
function vowelSet(lists: readonly (readonly string[])[], base: NameForm[], pool: Map<string, Token>): NameForm[] {
  const changed = vowelWords(lists[0]);
  return changed.every((word, i) => word === lists[0][i]) ? base : formsOf([changed], pool);
}

/** Нэрийг нэг удаа нормчилж бэлтгэнэ. Нормчилсон хэлбэр нь хоосон бол forms = []. */
export function prepareName(name: string, options: NameOptions = {}): PreparedName {
  const legalEntity = options.legalEntity === true;
  const pool = new Map<string, Token>();
  const whole: string[][] = [];
  const stripped: string[][] = [];
  for (const normalized of normalizeNameForms(legalEntity ? normalizeEntityName(name) : name)) {
    const words = tokenize(normalized);
    if (words.length === 0) continue;
    whole.push(words);
    const kept = legalEntity ? words.filter((word) => !isLegalFormToken(word)) : words;
    stripped.push(kept.length > 0 ? kept : words);
  }
  if (stripped.length === 0) return { name, forms: [], sets: [[], [], []] };

  const plain = formsOf(stripped, pool);
  const vowel = vowelSet(stripped, plain, pool);
  // ААН: хуулийн хэлбэрийг хассан нь хасаагүйгээс бага recall өгч болохгүй тул хасаагүй хувилбарыг мөн оноож max авна.
  const unstripped = legalEntity && !whole.every((words, i) => words.length === stripped[i].length) ? formsOf(whole, pool) : plain;
  return { name, forms: plain, sets: [plain, vowel, unstripped] };
}

/**
 * Jaro-Winkler-ийг тооцоолохоос өмнөх хямд шүүлтүүр. Хос PAIR_MIN (0.8)-д хүрэхэд ЗААВАЛ хоёр нөхцөл биелнэ, тиймээс шүүгдсэн хос
 * хэзээ ч таарахгүй байсан (recall буурахгүй):
 *  1. JW ≥ 0.8 → Jaro > 0.7 (boost нь Jaro ≤ 0.7 үед байхгүй). Jaro ≤ (2 + min/max) / 3 тул min/max > 0.1.
 *  2. Jaro > 0 → нэг ч нийтлэг тэмдэгтгүй байж болохгүй (mask-ийн AND ≠ 0; хэш мөргөлдөх нь зөвхөн илүү "тийм" гэнэ).
 */
export function mayMatch(a: Pick<Token, 'chars' | 'mask'>, b: Pick<Token, 'chars' | 'mask'>): boolean {
  if ((a.mask & b.mask) === 0) return false;
  const shorter = Math.min(a.chars.length, b.chars.length);
  const longer = Math.max(a.chars.length, b.chars.length);
  return shorter * 10 > longer;
}

// Токен хосын Jaro-Winkler. PAIR_MIN-д хүрэхгүй нь тодорхой хосыг дунд нь зогсоож 0 буцаана (jaro-winkler.ts): хос бүрийг бүрэн
// тооцдог байхад хамгийн их хугацаа зарцуулагддаг. Нэг бэлтгэсэн нэрийн хэлбэрүүд токеноо (Token объект) хуваалцдаг.
function tokenScore(ta: Token, tb: Token): number {
  return jaroWinklerCodePoints(ta.chars, tb.chars, PAIR_MIN - SCORE_EPSILON);
}

// Таараагүй токен ХОЁР талаас хоёулаа хохирол болно: "Bat Erdene" нь "Bat Erdene Ganbold"-той таарч харагдах ёсгүй,
// тиймээс хэсэгчилсэн давхцал reviewThreshold-оос доош үлдэнэ. Токен тутмын жин = үсгийн урт (урт токен илүү баримт).
function scoreTokens(a: NameForm, b: NameForm): number {
  const pairs: TokenPair[] = [];
  a.tokens.forEach((ta, i) => b.tokens.forEach((tb, j) => {
    if (!mayMatch(ta, tb)) return;
    const score = tokenScore(ta, tb);
    if (score >= PAIR_MIN - SCORE_EPSILON) pairs.push({ i, j, score, length: ta.text.length + tb.text.length });
  }));
  // Оноо буурахаар, тэнцвэл урт токен түрүүлж; Array.sort тогтвортой тул дараа нь (i, j) дарааллаар
  pairs.sort((p, q) => q.score - p.score || q.length - p.length);

  const usedA = new Set<number>();
  const usedB = new Set<number>();
  let numerator = 0;
  let denominator = 0;
  for (const { i, j, score } of pairs) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i);
    usedB.add(j);
    const weight = Math.max(a.tokens[i].text.length, b.tokens[j].text.length);
    numerator += score * weight;
    denominator += weight;
  }
  a.tokens.forEach((token, i) => { if (!usedA.has(i)) denominator += token.text.length; });
  b.tokens.forEach((token, j) => { if (!usedB.has(j)) denominator += token.text.length; });

  return Math.min(Math.max(numerator / denominator, 0), 1);
}

// Токенуудыг цикл дарааллаар эхлүүлж залгасан хэлбэрүүд: "Ганболд Батэрдэнэ" нь "Bat Erdene Ganbold"-той хил хязгаар БА дараалал
// хоёулаа зөрсөн (овог-нэр / нэр-овог) — Монгол нэрэнд энгийн тохиолдол. rotations[k] = k токеноор эргүүлсэн (0 = өөрчлөлтгүй).
interface Rotations { list: string[]; set: ReadonlySet<string> }
function rotationsOf(form: NameForm): Rotations {
  if (!form.rotations) {
    const words = form.tokens.map((t) => t.text);
    const list = words.map((_, k) => joinTokens([...words.slice(k), ...words.slice(0, k)]));
    form.rotations = { list, set: new Set(list) };
  }
  return form.rotations;
}

// Хоёр талын өөрчлөлтгүй (k = 0) залгасан хэлбэрийн тэнцэл нь ЭНД биш: тэр нь зөвхөн хил хязгаарын шилжилт (isBoundaryShift) байж
// л хүчинтэй. Өөрөөр бол залгах хилээр fold хийгдэж өөр нэр таардаг (Abdul Latif ~ Abdul Atif: "abdullatif" → "abdulatif").
function sharesRotation(a: NameForm, b: NameForm): boolean {
  const ra = rotationsOf(a);
  const rb = rotationsOf(b);
  for (let k = 1; k < ra.list.length; k++) if (ra.list[k] === rb.list[0]) return true;
  for (let k = 1; k < rb.list.length; k++) if (ra.set.has(rb.list[k])) return true;
  return false;
}

const hasInitialIn = (tokens: readonly Token[], from: number, to: number): boolean => {
  for (let k = from; k < to; k++) if (tokens[k].chars.length === 1) return true;
  return false;
};

/**
 * Хоёр нэр зөвхөн үгийн ХИЛ ХЯЗГААРААР ялгаатай эсэх: ижил эхлэл ба төгсгөл токенуудыг (яг тэнцүү) хасахад үлдсэн хэсэг хоёр талдаа
 * хоосон биш, ядаж нэг талд нь 2+ токен (нэгдсэн/салсан үг). Үлдсэн хэсгээс гадуурх токен бүр ЯГ таарна: нэг талын нэг токен бүхлээрээ
 * өөр (Malik bin Majid ~ Nasir bin Majid) нь хил хязгаарын зөрүү биш — токен хостой харьцуулалт хариуцна.
 * Инициал (нэг үсэгт токен) үлдсэн хэсэгт байвал нөгөө тал нь НЭГ үг байх ёстой (J R R ~ JRR); Li Na ~ Lin A мэт шилжилт өөр нэр.
 */
function isBoundaryShift(a: NameForm, b: NameForm): boolean {
  const at = a.tokens;
  const bt = b.tokens;
  let from = 0;
  const shortest = Math.min(at.length, bt.length);
  while (from < shortest && at[from].text === bt[from].text) from++;
  let toA = at.length;
  let toB = bt.length;
  while (toA > from && toB > from && at[toA - 1].text === bt[toB - 1].text) { toA--; toB--; }
  const na = toA - from;
  const nb = toB - from;
  if (na === 0 || nb === 0 || (na === 1 && nb === 1)) return false;
  if (hasInitialIn(at, from, toA) && nb !== 1) return false;
  if (hasInitialIn(bt, from, toB) && na !== 1) return false;
  return true;
}

// Үгийн хил хязгаар зөрсөн нэр (Abdul Rahman ~ Abdulrahman, Бат-Эрдэнэ ~ Батэрдэнэ): токен-токен харьцуулалт хоёр талын токены тоо
// зөрөхөд бүтэлгүйтдэг. Зайгүй залгасан хэлбэрийг засварын зайгаар (1 − зай / урт) харьцуулна — Jaro-Winkler биш, учир нь
// prefix boost нь "baterdene" ~ "baterdeneganbold" (хэсэгчилсэн давхцал)-ийг 0.91 болгоно. Харин ЗӨВХӨН хил хязгаарын шилжилтэд
// (isBoundaryShift) ба ДОРОО 1 засвартай: урт нэрийн нэг бүтэн богино токен зөрөхийг (Malik bin Majid ~ Nasir bin Majid) энэ зам
// хүлээн авахгүй. Инициалтай нэрэнд засвар 0 (Б.Ганбаатар ~ Д.Ганбаатар өөр хүн).
// Хил хязгаар зөрсөн дээр дараалал ч зөрсөн бол (токены циклийн эргэлт) зөвхөн ЯГ ижил үсгийн дарааллыг хүлээн авна; инициал
// эргэлтэд оролцохгүй (залгах хилээр fold хийгдэж Evans S ~ Evans E таардаг байсан).
// Хоёр зам хоёулаа VARIANT_SCORE_CAP-аас дээш гарахгүй: нормчилсон нэр ижил биш тул NAME_EXACT биш.
function scoreJoined(a: NameForm, b: NameForm): number {
  if (a.tokens.length < 2 && b.tokens.length < 2) return 0;
  if (a.digits !== b.digits) return 0;
  const initials = a.hasInitial || b.hasInitial;
  if (isBoundaryShift(a, b)) {
    const similarity = editSimilarity(a.joinedChars, b.joinedChars, JOINED_MIN, initials ? 0 : JOINED_MAX_EDITS);
    if (similarity > 0) return Math.min(similarity, VARIANT_SCORE_CAP);
  }
  if (!initials && a.tokens.length >= 2 && b.tokens.length >= 2 && sharesRotation(a, b)) return VARIANT_SCORE_CAP;
  return 0;
}

function scoreForms(a: NameForm, b: NameForm, digitCap: number): number {
  if (a.normalized === b.normalized) return 1;
  const score = Math.max(scoreTokens(a, b), scoreJoined(a, b));
  // Бүх-цифртэй токен хоёр талд байгаад зөрвөл (Group 1 ~ Group 2, 88 ~ 8) өөр нэгж: оноо review босгоос дээш гарахгүй.
  if (a.digitKey !== '' && b.digitKey !== '' && a.digitKey !== b.digitKey) return Math.min(score, digitCap);
  return score;
}

// Багц j өмнө нь хоёр талдаа ИЖИЛ массиваар тооцогдсон бол (өөрчлөлтгүй хувилбар) дахин тооцохгүй.
function scoredBefore(a: PreparedName, b: PreparedName, k: number): boolean {
  for (let j = 0; j < k; j++) if (a.sets[j] === a.sets[k] && b.sets[j] === b.sets[k]) return true;
  return false;
}

/** Бэлтгэсэн хоёр нэрийн ижилсэл: багц, хэлбэр хос бүрийн хамгийн өндөр оноо. Аль нэг нь хоосон бол 0. Тэгш хэмтэй. */
export function scorePreparedNames(a: PreparedName, b: PreparedName, options: ScoreOptions = {}): number {
  const digitCap = options.digitConflictCap ?? DIGIT_CONFLICT_CAP;
  let best = 0;
  for (let k = 0; k < a.sets.length; k++) {
    if (a.sets[k].length === 0 || b.sets[k].length === 0 || scoredBefore(a, b, k)) continue;
    // Багц 1 нь эгшгийн хувилбар: нормчилсон нэр ижил биш тул хамгийн ихдээ VOWEL_SCORE_CAP.
    const derived = k === VOWEL_SET;
    for (const fa of a.sets[k]) {
      for (const fb of b.sets[k]) {
        let score = scoreForms(fa, fb, digitCap);
        if (derived && score > VOWEL_SCORE_CAP) score = VOWEL_SCORE_CAP;
        if (score === 1) return 1;
        if (score > best) best = score;
      }
    }
  }
  return best;
}

/** 0..1, тэгш хэмтэй: nameSimilarity(a, b) === nameSimilarity(b, a). */
export function nameSimilarity(a: string, b: string, options: NameOptions & ScoreOptions = {}): number {
  return scorePreparedNames(prepareName(a, options), prepareName(b, options), options);
}

export interface NameMatch { score: number; subjectName: string; candidateName: string }

/** Бэлтгэсэн нэрсийн бүх хосын хамгийн өндөр ижилсэл. Хоосон нэрийг алгасна; тэнцвэл эхний хос. Нэр бүрийг ДАХИН нормчлохгүй. */
export function bestPreparedMatch(subjects: readonly PreparedName[], candidates: readonly PreparedName[], options: ScoreOptions = {}): NameMatch | null {
  let best: NameMatch | null = null;
  for (const subject of subjects) {
    if (subject.forms.length === 0) continue;
    for (const candidate of candidates) {
      if (candidate.forms.length === 0) continue;
      const score = scorePreparedNames(subject, candidate, options);
      if (best === null || score > best.score) best = { score, subjectName: subject.name, candidateName: candidate.name };
    }
  }
  return best;
}

/** Бүх хосын хамгийн өндөр ижилсэл. Аль нэг жагсаалт хоосон эсвэл зөвхөн хоосон нэртэй бол null. Тэнцвэл эхний хос. */
export function bestNameMatch(subjectNames: readonly string[], candidateNames: readonly string[], options: NameOptions & ScoreOptions = {}): NameMatch | null {
  return bestPreparedMatch(subjectNames.map((n) => prepareName(n, options)), candidateNames.map((n) => prepareName(n, options)), options);
}
