// BSA-ийн тохиргоо (NFR-6). Анхдагч утга ЗӨВХӨН энд (DEFAULT_BSA_SETTINGS); env-ээр дарна (EnvBsaSettingsProvider); 60с cache
// (CachedBsaSettingsProvider, CLAUDE.md §3.2(8)). Эзэмшигч нь origination.settings — түүний projection/GET client бэлэн болтол env/анхдагч.
import { z } from 'zod';
import { EnvConfigError, envInteger, envString, parseInteger, parseNumber, splitList, type EnvLike } from './env';
import type { BsaSettings, BsaSettingsProvider } from './infra.ports';

// ───────────────────────── Анхдагч утгууд (ЦОРЫН ГАНЦ газар) ─────────────────────────

/**
 * Бүх утга docs/02 §4 (BSA-BR-*) эсвэл infra.ports.ts-ийн тайлбараас; [ТААМАГ] гэсэн нь docs-д заагаагүй (docs/DECISIONS.md-д бичигдэнэ).
 */
export const DEFAULT_BSA_SETTINGS: Readonly<BsaSettings> = deepFreeze<BsaSettings>({
  /** BSA-BR-1: ББӨ 10% */
  costOfGoodsRate: 0.1,
  /** BSA-BR-2: ӨОХ ≤ 55% */
  maxDti: 0.55,
  /** BSA-BR-2: Бага/Дунд/Өндөр завсар «admin» гэсэн ч утга заагаагүй → [ТААМАГ] ≤35% Бага, ≤55% Дунд, түүнээс дээш Өндөр */
  dtiLevelThresholds: { lowMax: 0.35, mediumMax: 0.55 },
  /** BSA-BR-7: «Бусад» ангиллын босго 30% (docs-ийн жишээ) */
  otherShareThreshold: 0.3,
  /** BSA-BR-3 */
  allowedPeriodMonths: [3, 6, 12],
  /** BSA-FR-2.2: 6 сараас бага бол «N сарын хуулга дутуу» */
  minStatementMonths: 6,
  /** BSA-BR-8 */
  retentionYears: 3,
  /** classify/default-catalog.ts-ийн ангиллын кодууд */
  businessIncomeCodes: ['BUSINESS_INCOME'],
  irregularIncomeCodes: ['IRREGULAR_INCOME', 'ABNORMAL_INCOME', 'SUSPICIOUS_INCOME'],
  /** BSA-BR-4: найдварын жин (давтамж/тогтмол байдал/цэвэр байдал) — docs-д жин заагаагүй → [ТААМАГ] 0.4/0.4/0.2 */
  reliabilityWeights: { frequency: 0.4, consistency: 0.4, cleanliness: 0.2 },
  /** Үлдэгдлийн гинжийн зөвшөөрөх зөрүү (валютаар) — [ТААМАГ] 0.01 (бөөрөнхийлөлтийн алдаа) */
  balanceTolerance: 0.01,
  /** BSA-FR-5.3: admin «хориглох/анхааруулах» — анхдагч нь анхааруулах */
  pushPolicyWhenPendingSuspicious: 'WARN',
  /** 20 MiB (= 20 × 1024 × 1024 байт) — [ТААМАГ] */
  maxUploadBytes: 20 * 1024 * 1024,
  maxFilesPerUpload: 10,
});

/** Тохиргооны хүчин төгөлдөр утгын санитар хязгаар (бизнесийн дүрэм биш — алдаатай оролтоос хамгаална) */
export const SETTINGS_LIMITS = { maxMonths: 120, maxRetentionYears: 100, maxUploadBytes: 2 ** 31 - 1, maxFilesPerUpload: 1_000 } as const;
/** CLAUDE.md §3.2(8): cache 60с */
export const SETTINGS_CACHE_TTL_MS = 60_000;
/** Жингийн нийлбэр 1-тэй тэнцэх зөрүү (floating point) */
const WEIGHT_SUM_EPSILON = 1e-6;

// ───────────────────────── zod схем ─────────────────────────

const ratio = z.number().finite().min(0).max(1);
const months = z.number().int().min(1).max(SETTINGS_LIMITS.maxMonths);
const incomeCode = z.string().min(1).max(64).regex(/^[^\s,]+$/, 'must be a category code without whitespace or commas');
const thresholds = z.object({ lowMax: ratio, mediumMax: ratio }).strict();
const weights = z.object({ frequency: ratio, consistency: ratio, cleanliness: ratio }).strict();

const settingsObject = z
  .object({
    costOfGoodsRate: ratio,
    maxDti: ratio.gt(0),
    dtiLevelThresholds: thresholds,
    otherShareThreshold: ratio,
    allowedPeriodMonths: z.array(months).min(1),
    minStatementMonths: months,
    retentionYears: z.number().int().min(1).max(SETTINGS_LIMITS.maxRetentionYears),
    businessIncomeCodes: z.array(incomeCode).min(1),
    irregularIncomeCodes: z.array(incomeCode),
    reliabilityWeights: weights,
    balanceTolerance: z.number().finite().min(0),
    pushPolicyWhenPendingSuspicious: z.enum(['WARN', 'BLOCK']),
    maxUploadBytes: z.number().int().min(1).max(SETTINGS_LIMITS.maxUploadBytes),
    maxFilesPerUpload: z.number().int().min(1).max(SETTINGS_LIMITS.maxFilesPerUpload),
  })
  .strict();

/** Бүтэн тохиргоо + талбар хоорондын дүрмүүд */
export const BsaSettingsSchema = settingsObject.superRefine((s, ctx) => {
  if (s.dtiLevelThresholds.lowMax > s.dtiLevelThresholds.mediumMax) {
    ctx.addIssue({
      code: 'custom',
      path: ['dtiLevelThresholds'],
      message: `lowMax (${s.dtiLevelThresholds.lowMax}) must be <= mediumMax (${s.dtiLevelThresholds.mediumMax})`,
    });
  }
  const sum = s.reliabilityWeights.frequency + s.reliabilityWeights.consistency + s.reliabilityWeights.cleanliness;
  if (Math.abs(sum - 1) > WEIGHT_SUM_EPSILON) {
    ctx.addIssue({ code: 'custom', path: ['reliabilityWeights'], message: `weights must sum to 1 (got ${Number(sum.toFixed(9))})` });
  }
  if (new Set(s.allowedPeriodMonths).size !== s.allowedPeriodMonths.length) {
    ctx.addIssue({ code: 'custom', path: ['allowedPeriodMonths'], message: 'must not contain duplicates' });
  }
  const business = new Set(s.businessIncomeCodes);
  const both = s.irregularIncomeCodes.filter((c) => business.has(c));
  if (both.length > 0) {
    const message = `codes cannot be both business and irregular income: ${both.join(', ')}`;
    ctx.addIssue({ code: 'custom', path: ['irregularIncomeCodes'], message });
  }
});

/** Хэсэгчилсэн дарагч (origination-ийн тохиргоо г.м): бүх түвшин сонголттой, үл мэдэгдэх түлхүүр татгалзана */
export const BsaSettingsOverridesSchema = settingsObject.deepPartial();
export type BsaSettingsOverrides = z.infer<typeof BsaSettingsOverridesSchema>;

export class BsaSettingsError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`invalid BSA settings: ${issues.join('; ')}`);
    this.name = 'BsaSettingsError';
  }
}

const issueText = (i: z.ZodIssue): string => `${i.path.join('.') || '(root)'}: ${i.message}`;

/** Бүтэн тохиргоог шалгаж, deep-frozen хуулбар буцаана. Алдаа → BsaSettingsError (бүх зөрчлийг жагсаана) */
export function parseBsaSettings(raw: unknown): BsaSettings {
  const parsed = BsaSettingsSchema.safeParse(raw);
  if (!parsed.success) throw new BsaSettingsError(parsed.error.issues.map(issueText));
  return deepFreeze<BsaSettings>(parsed.data);
}

/** base дээр overrides-ыг давхарлана (nested объект талбараар, массив бүтнээр нь солигдоно). Шалгахгүй — parseBsaSettings хийнэ */
export function mergeSettings(base: BsaSettings, overrides: BsaSettingsOverrides): unknown {
  return {
    ...base,
    ...overrides,
    dtiLevelThresholds: { ...base.dtiLevelThresholds, ...overrides.dtiLevelThresholds },
    reliabilityWeights: { ...base.reliabilityWeights, ...overrides.reliabilityWeights },
  };
}

// ───────────────────────── Env provider ─────────────────────────

type Draft = BsaSettings;
interface EnvSpec {
  env: string;
  /** Тохиргооны замын нэр (алдааг env хувьсагчтай холбоход) */
  path: string;
  read(raw: string): unknown;
  set(draft: Draft, value: never): void;
}

type NumberSetter = (d: Draft, v: number) => void;
const numeric = (parse: (name: string, raw: string) => number) => (env: string, path: string, set: NumberSetter): EnvSpec => ({
  env, path, read: (raw) => parse(env, raw), set: set as EnvSpec['set'],
});
const num = numeric(parseNumber);
const int = numeric(parseInteger);

/** Хувьсагч → талбар. Нэмэхэд нэг мөр; нэг утгын шалгалтыг BsaSettingsSchema өөрөө хийнэ */
const ENV_SPECS: readonly EnvSpec[] = [
  num('BSA_COST_OF_GOODS_RATE', 'costOfGoodsRate', (d, v) => void (d.costOfGoodsRate = v)),
  num('BSA_MAX_DTI', 'maxDti', (d, v) => void (d.maxDti = v)),
  num('BSA_DTI_LOW_MAX', 'dtiLevelThresholds.lowMax', (d, v) => void (d.dtiLevelThresholds.lowMax = v)),
  num('BSA_DTI_MEDIUM_MAX', 'dtiLevelThresholds.mediumMax', (d, v) => void (d.dtiLevelThresholds.mediumMax = v)),
  num('BSA_OTHER_SHARE_THRESHOLD', 'otherShareThreshold', (d, v) => void (d.otherShareThreshold = v)),
  int('BSA_MIN_STATEMENT_MONTHS', 'minStatementMonths', (d, v) => void (d.minStatementMonths = v)),
  int('BSA_RETENTION_YEARS', 'retentionYears', (d, v) => void (d.retentionYears = v)),
  num('BSA_BALANCE_TOLERANCE', 'balanceTolerance', (d, v) => void (d.balanceTolerance = v)),
  int('BSA_MAX_UPLOAD_BYTES', 'maxUploadBytes', (d, v) => void (d.maxUploadBytes = v)),
  int('BSA_MAX_FILES_PER_UPLOAD', 'maxFilesPerUpload', (d, v) => void (d.maxFilesPerUpload = v)),
  num('BSA_RELIABILITY_WEIGHT_FREQUENCY', 'reliabilityWeights.frequency', (d, v) => void (d.reliabilityWeights.frequency = v)),
  num('BSA_RELIABILITY_WEIGHT_CONSISTENCY', 'reliabilityWeights.consistency', (d, v) => void (d.reliabilityWeights.consistency = v)),
  num('BSA_RELIABILITY_WEIGHT_CLEANLINESS', 'reliabilityWeights.cleanliness', (d, v) => void (d.reliabilityWeights.cleanliness = v)),
  {
    env: 'BSA_PUSH_POLICY',
    path: 'pushPolicyWhenPendingSuspicious',
    read: (raw) => raw.toUpperCase(),
    set: ((d: Draft, v: Draft['pushPolicyWhenPendingSuspicious']) => void (d.pushPolicyWhenPendingSuspicious = v)) as EnvSpec['set'],
  },
  {
    env: 'BSA_ALLOWED_PERIOD_MONTHS',
    path: 'allowedPeriodMonths',
    read: (raw) => splitList(raw).map((p) => parseInteger('BSA_ALLOWED_PERIOD_MONTHS', p)),
    set: ((d: Draft, v: number[]) => void (d.allowedPeriodMonths = v)) as EnvSpec['set'],
  },
  {
    env: 'BSA_BUSINESS_INCOME_CODES',
    path: 'businessIncomeCodes',
    read: (raw) => splitList(raw),
    set: ((d: Draft, v: string[]) => void (d.businessIncomeCodes = v)) as EnvSpec['set'],
  },
  {
    env: 'BSA_IRREGULAR_INCOME_CODES',
    path: 'irregularIncomeCodes',
    read: (raw) => splitList(raw),
    set: ((d: Draft, v: string[]) => void (d.irregularIncomeCodes = v)) as EnvSpec['set'],
  },
];

/** Тохируулах боломжтой env хувьсагчид (README-д баримтжуулсан; тест хоёр хоорондын нийцлийг шалгана) */
export const BSA_SETTINGS_ENV_VARIABLES: readonly string[] = ENV_SPECS.map((s) => s.env);

/**
 * Анхдагч утга дээр env-ийн дарагчийг тавина. Буруу утга CONSTRUCTOR дээр шууд унана (fail fast) — хувьсагчийн нэр, шалтгаан,
 * талбар хоорондын зөрчил бол аль env-үүд оролцсоныг нэрлэнэ. `get()` нь deep-frozen, бүх байгууллагад ижил утга буцаана.
 */
export class EnvBsaSettingsProvider implements BsaSettingsProvider {
  readonly settings: BsaSettings;

  constructor(env: EnvLike = process.env, base: BsaSettings = DEFAULT_BSA_SETTINGS) {
    const draft = structuredClone(base) as Draft;
    const provided = new Set<string>();
    for (const spec of ENV_SPECS) {
      const raw = envString(env, spec.env);
      if (raw === undefined) continue;
      spec.set(draft, spec.read(raw) as never);
      provided.add(spec.env);
    }
    const parsed = BsaSettingsSchema.safeParse(draft);
    if (!parsed.success) throw new BsaSettingsError(parsed.error.issues.map((i) => annotate(i, provided)));
    this.settings = deepFreeze<BsaSettings>(parsed.data);
  }

  // TODO(M13): orgId-аар тусгаарлах override-ыг OverriddenBsaSettingsProvider (доор) дундуур нэмнэ
  get(_orgId: string): Promise<BsaSettings> {
    return Promise.resolve(this.settings);
  }
}

/** Схемийн зөрчлийг тухайн замтай холбогдох, ОРУУЛСАН env хувьсагчаар тодруулна: "…: msg [from env BSA_X, BSA_Y]" */
function annotate(issue: z.ZodIssue, provided: ReadonlySet<string>): string {
  const path = issue.path.join('.');
  const overlaps = (p: string): boolean => p === path || p.startsWith(`${path}.`) || path.startsWith(`${p}.`);
  const related = ENV_SPECS.filter((s) => provided.has(s.env) && overlaps(s.path));
  return `${issueText(issue)}${related.length > 0 ? ` [from env ${related.map((s) => s.env).join(', ')}]` : ''}`;
}

// ───────────────────────── Origination-ийн тохиргооны seam ─────────────────────────

/**
 * TODO(M13): origination.settings-ийн `SettingsChanged` projection эсвэл sync GET (CLAUDE.md §3.2(8)) клиентийг ЭНД залгана:
 * `fetch(orgId)` нь тухайн байгууллагын BSA тохиргооны зөвхөн админ тохируулсан хэсгийг (хэсэгчилсэн) буцаана, байхгүй бол null.
 * Бүтээгдэхүүний ББӨ (BSA-BR-1) энд биш — DtiRunInput.costOfGoodsRate-аар хүсэлт бүрт ирнэ.
 */
export interface BsaSettingsOverrideSource {
  fetch(orgId: string): Promise<BsaSettingsOverrides | null | undefined>;
}

/** `base` (env/анхдагч) дээр `source`-ийн дарагчийг тавьж бүтнээр нь дахин шалгана. Source буруу өгөгдөл өгвөл BsaSettingsError */
export class OverriddenBsaSettingsProvider implements BsaSettingsProvider {
  constructor(private readonly base: BsaSettingsProvider, private readonly source: BsaSettingsOverrideSource) {}

  async get(orgId: string): Promise<BsaSettings> {
    const [base, raw] = await Promise.all([this.base.get(orgId), this.source.fetch(orgId)]);
    if (raw === null || raw === undefined) return base;
    const overrides = BsaSettingsOverridesSchema.safeParse(raw);
    if (!overrides.success) throw new BsaSettingsError(overrides.error.issues.map((i) => `override ${issueText(i)}`));
    return parseBsaSettings(mergeSettings(base, overrides.data));
  }
}

// ───────────────────────── Cache ─────────────────────────

export interface CachedBsaSettingsProviderOptions {
  /** Анхдагч 60 000 (CLAUDE.md §3.2(8)). 0 = cache-гүй (зэрэгцээ дуудлагыг л нэгтгэнэ) */
  ttlMs?: number;
  /** Тестэд тогтмол цаг. Анхдагч Date.now */
  now?: () => number;
  /** Байгууллагын тоо хязгаар (толгойноос ирэх orgId-аар санах ой тэлэхээс хамгаална) */
  maxEntries?: number;
}

/**
 * Дотоод provider-ийн хариуг org тутамд ttl хугацаанд хадгална. Давхар зэрэгцээ дуудлага нэг fetch-ийг хуваалцана (single-flight);
 * алдаа cache-лэгдэхгүй (дараагийн дуудлага дахин оролдоно); invalidate() (жишээ нь SettingsChanged event) fetch явж байх үед ч хүчинтэй.
 */
export class CachedBsaSettingsProvider implements BsaSettingsProvider {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, { value: BsaSettings; expiresAt: number }>();
  readonly #inflight = new Map<string, Promise<BsaSettings>>();
  #generation = 0;

  constructor(private readonly inner: BsaSettingsProvider, options: CachedBsaSettingsProviderOptions = {}) {
    this.#ttlMs = options.ttlMs ?? SETTINGS_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#maxEntries = options.maxEntries ?? 1_000;
    if (!Number.isFinite(this.#ttlMs) || this.#ttlMs < 0) {
      throw new EnvConfigError('BSA_SETTINGS_CACHE_TTL_MS', `ttl must be >= 0, got ${this.#ttlMs}`);
    }
    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1) throw new RangeError('maxEntries must be an integer >= 1');
  }

  get(orgId: string): Promise<BsaSettings> {
    const hit = this.#entries.get(orgId);
    if (hit && hit.expiresAt > this.#now()) return Promise.resolve(hit.value);
    const pending = this.#inflight.get(orgId);
    if (pending) return pending;

    const generation = this.#generation;
    const fetch = Promise.resolve()
      .then(() => this.inner.get(orgId))
      .then((raw) => {
        const value = deepFreeze<BsaSettings>(structuredClone(raw));
        if (generation === this.#generation && this.#ttlMs > 0) this.#store(orgId, value);
        return value;
      })
      .finally(() => {
        if (this.#inflight.get(orgId) === fetch) this.#inflight.delete(orgId);
      });
    this.#inflight.set(orgId, fetch);
    return fetch;
  }

  /** orgId өгвөл тэр байгууллагынх, үгүй бол бүгдийг хүчингүй болгоно */
  invalidate(orgId?: string): void {
    this.#generation += 1;
    if (orgId === undefined) this.#entries.clear();
    else this.#entries.delete(orgId);
    // Яваа fetch-ийн үр дүн хуучин байж болох тул түүнийг дараагийн дуудлагад дахин ашиглахгүй
    if (orgId === undefined) this.#inflight.clear();
    else this.#inflight.delete(orgId);
  }

  #store(orgId: string, value: BsaSettings): void {
    this.#entries.delete(orgId);
    this.#entries.set(orgId, { value, expiresAt: this.#now() + this.#ttlMs });
    // Хамгийн хуучныг гаргана (Map нэмэгдсэн дарааллаа хадгалдаг)
    while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value as string);
  }
}

export interface CreateBsaSettingsProviderOptions {
  /** TODO(M13): origination.settings-ийн client. Өгөөгүй бол зөвхөн env/анхдагч */
  source?: BsaSettingsOverrideSource;
  now?: () => number;
}

/** Cache(Overridden?(Env)). Env: BSA_* (settings.ts-ийн ENV_SPECS) + BSA_SETTINGS_CACHE_TTL_MS */
export function createBsaSettingsProvider(
  env: EnvLike = process.env,
  options: CreateBsaSettingsProviderOptions = {},
): CachedBsaSettingsProvider {
  const fromEnv = new EnvBsaSettingsProvider(env);
  const inner = options.source ? new OverriddenBsaSettingsProvider(fromEnv, options.source) : fromEnv;
  return new CachedBsaSettingsProvider(inner, { ttlMs: envInteger(env, 'BSA_SETTINGS_CACHE_TTL_MS', { min: 0 }), now: options.now });
}

// ───────────────────────── туслах ─────────────────────────

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
