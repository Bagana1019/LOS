// BSA тохиргоо: анхдагч утга, zod схем, env override (fail fast), 60с cache, origination seam.
import { describe, expect, it, vi } from 'vitest';
import { EnvConfigError } from './env';
import type { BsaSettings, BsaSettingsProvider } from './infra.ports';
import {
  BSA_SETTINGS_ENV_VARIABLES,
  BsaSettingsError,
  BsaSettingsOverridesSchema,
  BsaSettingsSchema,
  CachedBsaSettingsProvider,
  createBsaSettingsProvider,
  DEFAULT_BSA_SETTINGS,
  EnvBsaSettingsProvider,
  OverriddenBsaSettingsProvider,
  parseBsaSettings,
  SETTINGS_CACHE_TTL_MS,
} from './settings';

const clone = (): BsaSettings => structuredClone(DEFAULT_BSA_SETTINGS) as BsaSettings;
const withChange = (change: (s: Record<string, unknown>) => void): unknown => {
  const s = clone() as unknown as Record<string, unknown>;
  change(s);
  return s;
};

describe('DEFAULT_BSA_SETTINGS', () => {
  it('holds exactly the documented defaults (docs/02 §4 + infra.ports.ts)', () => {
    expect(DEFAULT_BSA_SETTINGS).toEqual({
      costOfGoodsRate: 0.1,
      maxDti: 0.55,
      dtiLevelThresholds: { lowMax: 0.35, mediumMax: 0.55 },
      otherShareThreshold: 0.3,
      allowedPeriodMonths: [3, 6, 12],
      minStatementMonths: 6,
      retentionYears: 3,
      businessIncomeCodes: ['BUSINESS_INCOME'],
      irregularIncomeCodes: ['IRREGULAR_INCOME', 'ABNORMAL_INCOME', 'SUSPICIOUS_INCOME'],
      reliabilityWeights: { frequency: 0.4, consistency: 0.4, cleanliness: 0.2 },
      balanceTolerance: 0.01,
      pushPolicyWhenPendingSuspicious: 'WARN',
      maxUploadBytes: 20 * 1024 * 1024,
      maxFilesPerUpload: 10,
    });
  });

  it('passes its own schema and is deeply immutable', () => {
    expect(BsaSettingsSchema.safeParse(DEFAULT_BSA_SETTINGS).success).toBe(true);
    const mutable = DEFAULT_BSA_SETTINGS as BsaSettings;
    expect(() => {
      mutable.maxDti = 0.9;
    }).toThrow(TypeError);
    expect(() => {
      mutable.allowedPeriodMonths.push(24);
    }).toThrow(TypeError);
    expect(() => {
      mutable.reliabilityWeights.frequency = 1;
    }).toThrow(TypeError);
    expect(DEFAULT_BSA_SETTINGS.maxDti).toBe(0.55);
  });
});

describe('BsaSettingsSchema', () => {
  it('accepts valid edge values (0 and 1 ratios, float weights summing to 1)', () => {
    const ok = [
      withChange((s) => (s.costOfGoodsRate = 0)),
      withChange((s) => (s.costOfGoodsRate = 1)),
      withChange((s) => (s.maxDti = 1)),
      withChange((s) => (s.dtiLevelThresholds = { lowMax: 0.55, mediumMax: 0.55 })),
      withChange((s) => (s.dtiLevelThresholds = { lowMax: 0, mediumMax: 0 })),
      withChange((s) => (s.reliabilityWeights = { frequency: 0.1, consistency: 0.2, cleanliness: 0.7 })), // 0.1+0.2+0.7 != 1 binary-exactly
      withChange((s) => (s.reliabilityWeights = { frequency: 1, consistency: 0, cleanliness: 0 })),
      withChange((s) => (s.irregularIncomeCodes = [])),
      withChange((s) => (s.balanceTolerance = 0)),
      withChange((s) => (s.pushPolicyWhenPendingSuspicious = 'BLOCK')),
      withChange((s) => (s.allowedPeriodMonths = [12])),
    ];
    for (const candidate of ok) expect(() => parseBsaSettings(candidate)).not.toThrow();
  });

  it.each([
    ['ББӨ below 0', (s: Record<string, unknown>) => (s.costOfGoodsRate = -0.01), 'costOfGoodsRate'],
    ['ББӨ above 1', (s) => (s.costOfGoodsRate = 1.01), 'costOfGoodsRate'],
    ['ББӨ NaN', (s) => (s.costOfGoodsRate = Number.NaN), 'costOfGoodsRate'],
    ['ББӨ Infinity', (s) => (s.costOfGoodsRate = Number.POSITIVE_INFINITY), 'costOfGoodsRate'],
    ['ББӨ as string', (s) => (s.costOfGoodsRate = '0.1'), 'costOfGoodsRate'],
    ['maxDti 0', (s) => (s.maxDti = 0), 'maxDti'],
    ['maxDti above 1', (s) => (s.maxDti = 1.5), 'maxDti'],
    ['lowMax above mediumMax', (s) => (s.dtiLevelThresholds = { lowMax: 0.6, mediumMax: 0.5 }), 'dtiLevelThresholds'],
    ['threshold above 1', (s) => (s.dtiLevelThresholds = { lowMax: 0.2, mediumMax: 1.2 }), 'dtiLevelThresholds.mediumMax'],
    ['threshold missing', (s) => (s.dtiLevelThresholds = { lowMax: 0.2 }), 'dtiLevelThresholds.mediumMax'],
    ['other share above 1', (s) => (s.otherShareThreshold = 30), 'otherShareThreshold'],
    ['empty periods', (s) => (s.allowedPeriodMonths = []), 'allowedPeriodMonths'],
    ['zero period', (s) => (s.allowedPeriodMonths = [0, 6]), 'allowedPeriodMonths'],
    ['fractional period', (s) => (s.allowedPeriodMonths = [1.5]), 'allowedPeriodMonths'],
    ['duplicate periods', (s) => (s.allowedPeriodMonths = [3, 3, 6]), 'allowedPeriodMonths'],
    ['absurd period', (s) => (s.allowedPeriodMonths = [121]), 'allowedPeriodMonths'],
    ['min months 0', (s) => (s.minStatementMonths = 0), 'minStatementMonths'],
    ['retention 0', (s) => (s.retentionYears = 0), 'retentionYears'],
    ['retention fractional', (s) => (s.retentionYears = 2.5), 'retentionYears'],
    ['no business codes', (s) => (s.businessIncomeCodes = []), 'businessIncomeCodes'],
    ['code with whitespace', (s) => (s.businessIncomeCodes = ['BUSINESS INCOME']), 'businessIncomeCodes'],
    ['code with comma', (s) => (s.irregularIncomeCodes = ['A,B']), 'irregularIncomeCodes'],
    ['code both business and irregular', (s) => (s.irregularIncomeCodes = ['BUSINESS_INCOME', 'X']), 'irregularIncomeCodes'],
    ['weights sum below 1', (s) => (s.reliabilityWeights = { frequency: 0.3, consistency: 0.3, cleanliness: 0.3 }), 'reliabilityWeights'],
    ['weights sum above 1', (s) => (s.reliabilityWeights = { frequency: 0.5, consistency: 0.5, cleanliness: 0.5 }), 'reliabilityWeights'],
    ['negative weight', (s) => (s.reliabilityWeights = { frequency: 1.2, consistency: -0.2, cleanliness: 0 }), 'reliabilityWeights.consistency'],
    ['negative tolerance', (s) => (s.balanceTolerance = -0.01), 'balanceTolerance'],
    ['unknown push policy', (s) => (s.pushPolicyWhenPendingSuspicious = 'ALLOW'), 'pushPolicyWhenPendingSuspicious'],
    ['upload 0 bytes', (s) => (s.maxUploadBytes = 0), 'maxUploadBytes'],
    ['upload fractional', (s) => (s.maxUploadBytes = 1.5), 'maxUploadBytes'],
    ['upload above 2 GiB', (s) => (s.maxUploadBytes = 2 ** 31), 'maxUploadBytes'],
    ['0 files', (s) => (s.maxFilesPerUpload = 0), 'maxFilesPerUpload'],
    ['too many files', (s) => (s.maxFilesPerUpload = 1_001), 'maxFilesPerUpload'],
    ['unknown (typo) key', (s) => (s.costOfGoodRate = 0.2), '(root)'],
    ['unknown nested key', (s) => (s.reliabilityWeights = { frequency: 0.4, consistency: 0.4, cleanliness: 0.2, extra: 0 }), 'reliabilityWeights'],
    ['missing field', (s) => delete s.maxDti, 'maxDti'],
  ] as Array<[string, (s: Record<string, unknown>) => unknown, string]>)('rejects: %s', (_name, change, path) => {
    const candidate = withChange((s) => void change(s));
    let error: unknown;
    try {
      parseBsaSettings(candidate);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BsaSettingsError);
    expect((error as BsaSettingsError).issues.some((i) => new RegExp(`^${path.replace(/[.()]/g, '\\$&')}(\\.\\d+)?:`).test(i))).toBe(true);
  });

  it('reports every violation at once', () => {
    const candidate = withChange((s) => {
      s.maxDti = 2;
      s.costOfGoodsRate = -1;
      s.allowedPeriodMonths = [];
    });
    expect((() => { try { parseBsaSettings(candidate); } catch (e) { return e as BsaSettingsError; } })()?.issues).toHaveLength(3);
  });

  it('parseBsaSettings returns an independent deeply frozen copy', () => {
    const input = clone();
    const out = parseBsaSettings(input);
    expect(out).toEqual(input);
    expect(Object.isFrozen(out.reliabilityWeights)).toBe(true);
    input.maxDti = 0.9;
    expect(out.maxDti).toBe(0.55);
  });

  it('overrides schema is deep partial but still rejects unknown keys and bad values', () => {
    expect(BsaSettingsOverridesSchema.safeParse({}).success).toBe(true);
    expect(BsaSettingsOverridesSchema.safeParse({ dtiLevelThresholds: { lowMax: 0.2 } }).success).toBe(true);
    expect(BsaSettingsOverridesSchema.safeParse({ typo: 1 }).success).toBe(false);
    expect(BsaSettingsOverridesSchema.safeParse({ dtiLevelThresholds: { lowMax: 5 } }).success).toBe(false);
    expect(BsaSettingsOverridesSchema.safeParse({ reliabilityWeights: { nope: 1 } }).success).toBe(false);
  });
});

describe('EnvBsaSettingsProvider', () => {
  it('without env equals the defaults (and never mutates them)', async () => {
    const p = new EnvBsaSettingsProvider({});
    await expect(p.get('any-org')).resolves.toEqual(DEFAULT_BSA_SETTINGS);
    new EnvBsaSettingsProvider({ BSA_MAX_DTI: '0.4' });
    expect(DEFAULT_BSA_SETTINGS.maxDti).toBe(0.55);
  });

  it.each([
    ['BSA_COST_OF_GOODS_RATE', '0.15', (s: BsaSettings) => s.costOfGoodsRate, 0.15],
    ['BSA_MAX_DTI', '0.5', (s: BsaSettings) => s.maxDti, 0.5],
    ['BSA_DTI_LOW_MAX', '0.3', (s: BsaSettings) => s.dtiLevelThresholds.lowMax, 0.3],
    ['BSA_DTI_MEDIUM_MAX', '0.45', (s: BsaSettings) => s.dtiLevelThresholds.mediumMax, 0.45],
    ['BSA_OTHER_SHARE_THRESHOLD', '0.2', (s: BsaSettings) => s.otherShareThreshold, 0.2],
    ['BSA_MIN_STATEMENT_MONTHS', '12', (s: BsaSettings) => s.minStatementMonths, 12],
    ['BSA_RETENTION_YEARS', '5', (s: BsaSettings) => s.retentionYears, 5],
    ['BSA_BALANCE_TOLERANCE', '0.5', (s: BsaSettings) => s.balanceTolerance, 0.5],
    ['BSA_PUSH_POLICY', 'BLOCK', (s: BsaSettings) => s.pushPolicyWhenPendingSuspicious, 'BLOCK'],
    ['BSA_PUSH_POLICY', ' block ', (s: BsaSettings) => s.pushPolicyWhenPendingSuspicious, 'BLOCK'],
    ['BSA_MAX_UPLOAD_BYTES', '1048576', (s: BsaSettings) => s.maxUploadBytes, 1_048_576],
    ['BSA_MAX_FILES_PER_UPLOAD', '3', (s: BsaSettings) => s.maxFilesPerUpload, 3],
    ['BSA_ALLOWED_PERIOD_MONTHS', '1, 6 ,24', (s: BsaSettings) => s.allowedPeriodMonths, [1, 6, 24]],
    ['BSA_BUSINESS_INCOME_CODES', 'BUSINESS_INCOME,SALES', (s: BsaSettings) => s.businessIncomeCodes, ['BUSINESS_INCOME', 'SALES']],
    ['BSA_IRREGULAR_INCOME_CODES', 'GIFT', (s: BsaSettings) => s.irregularIncomeCodes, ['GIFT']],
  ])('%s=%j overrides the default', (name, value, read, expected) => {
    expect(read(new EnvBsaSettingsProvider({ [name]: value }).settings)).toEqual(expected);
  });

  it('reliability weights can be overridden together (sum must stay 1)', () => {
    const p = new EnvBsaSettingsProvider({
      BSA_RELIABILITY_WEIGHT_FREQUENCY: '0.5',
      BSA_RELIABILITY_WEIGHT_CONSISTENCY: '0.3',
      BSA_RELIABILITY_WEIGHT_CLEANLINESS: '0.2',
    });
    expect(p.settings.reliabilityWeights).toEqual({ frequency: 0.5, consistency: 0.3, cleanliness: 0.2 });
  });

  it('blank values mean "not set"', () => {
    const p = new EnvBsaSettingsProvider({ BSA_MAX_DTI: '', BSA_ALLOWED_PERIOD_MONTHS: '  ', BSA_PUSH_POLICY: ' ' });
    expect(p.settings).toEqual(DEFAULT_BSA_SETTINGS);
  });

  it('applies a custom base instead of the defaults', () => {
    const base = { ...clone(), maxDti: 0.45, dtiLevelThresholds: { lowMax: 0.2, mediumMax: 0.45 } };
    expect(new EnvBsaSettingsProvider({ BSA_COST_OF_GOODS_RATE: '0.2' }, base).settings).toMatchObject({ maxDti: 0.45, costOfGoodsRate: 0.2 });
  });

  describe('invalid values fail fast at construction with a precise message', () => {
    it.each([
      ['not a number', { BSA_MAX_DTI: 'abc' }, /BSA_MAX_DTI: expected a plain decimal number, got "abc"/],
      ['percent sign', { BSA_COST_OF_GOODS_RATE: '10%' }, /BSA_COST_OF_GOODS_RATE/],
      ['scientific notation', { BSA_BALANCE_TOLERANCE: '1e-2' }, /BSA_BALANCE_TOLERANCE/],
      ['hex', { BSA_MAX_UPLOAD_BYTES: '0x10' }, /BSA_MAX_UPLOAD_BYTES/],
      ['MB suffix', { BSA_MAX_UPLOAD_BYTES: '20MB' }, /BSA_MAX_UPLOAD_BYTES/],
      ['fractional integer', { BSA_MAX_FILES_PER_UPLOAD: '2.5' }, /BSA_MAX_FILES_PER_UPLOAD: expected an integer/],
      ['bad list member', { BSA_ALLOWED_PERIOD_MONTHS: '3,x' }, /BSA_ALLOWED_PERIOD_MONTHS/],
    ])('%s -> EnvConfigError naming the variable', (_n, env, pattern) => {
      expect(() => new EnvBsaSettingsProvider(env)).toThrow(EnvConfigError);
      expect(() => new EnvBsaSettingsProvider(env)).toThrow(pattern);
    });

    it.each([
      ['ratio above 1', { BSA_MAX_DTI: '1.5' }, /maxDti.*\[from env BSA_MAX_DTI\]/],
      ['negative ratio', { BSA_COST_OF_GOODS_RATE: '-0.1' }, /costOfGoodsRate.*BSA_COST_OF_GOODS_RATE/],
      ['maxDti zero', { BSA_MAX_DTI: '0' }, /BSA_MAX_DTI/],
      ['lowMax above the default mediumMax', { BSA_DTI_LOW_MAX: '0.9' }, /lowMax \(0\.9\) must be <= mediumMax \(0\.55\).*BSA_DTI_LOW_MAX/],
      ['mediumMax below the default lowMax', { BSA_DTI_MEDIUM_MAX: '0.2' }, /lowMax \(0\.35\) must be <= mediumMax \(0\.2\).*BSA_DTI_MEDIUM_MAX/],
      ['unknown push policy', { BSA_PUSH_POLICY: 'ALLOW' }, /pushPolicyWhenPendingSuspicious.*BSA_PUSH_POLICY/],
      ['a single weight changed (sum != 1)', { BSA_RELIABILITY_WEIGHT_FREQUENCY: '0.5' }, /weights must sum to 1.*BSA_RELIABILITY_WEIGHT_FREQUENCY/],
      ['upload 0', { BSA_MAX_UPLOAD_BYTES: '0' }, /maxUploadBytes.*BSA_MAX_UPLOAD_BYTES/],
      ['retention 0', { BSA_RETENTION_YEARS: '0' }, /BSA_RETENTION_YEARS/],
      ['duplicate periods', { BSA_ALLOWED_PERIOD_MONTHS: '3,3' }, /duplicates.*BSA_ALLOWED_PERIOD_MONTHS/],
      ['code both business and irregular', { BSA_BUSINESS_INCOME_CODES: 'IRREGULAR_INCOME' }, /both business and irregular/],
    ])('%s -> BsaSettingsError naming the variable', (_n, env, pattern) => {
      expect(() => new EnvBsaSettingsProvider(env)).toThrow(BsaSettingsError);
      expect(() => new EnvBsaSettingsProvider(env)).toThrow(pattern);
    });
  });

  it('get() returns the same immutable snapshot for every org', async () => {
    const p = new EnvBsaSettingsProvider({ BSA_MAX_DTI: '0.5' });
    const [a, b] = await Promise.all([p.get('org-1'), p.get('org-2')]);
    expect(a).toBe(b);
    expect(() => {
      (a as BsaSettings).maxDti = 0.9;
    }).toThrow(TypeError);
  });

  it('exposes the documented variable list', () => {
    expect([...BSA_SETTINGS_ENV_VARIABLES].sort()).toEqual(
      [
        'BSA_ALLOWED_PERIOD_MONTHS', 'BSA_BALANCE_TOLERANCE', 'BSA_BUSINESS_INCOME_CODES', 'BSA_COST_OF_GOODS_RATE', 'BSA_DTI_LOW_MAX', 'BSA_DTI_MEDIUM_MAX',
        'BSA_IRREGULAR_INCOME_CODES', 'BSA_MAX_DTI', 'BSA_MAX_FILES_PER_UPLOAD', 'BSA_MAX_UPLOAD_BYTES', 'BSA_MIN_STATEMENT_MONTHS', 'BSA_OTHER_SHARE_THRESHOLD',
        'BSA_PUSH_POLICY', 'BSA_RELIABILITY_WEIGHT_CLEANLINESS', 'BSA_RELIABILITY_WEIGHT_CONSISTENCY', 'BSA_RELIABILITY_WEIGHT_FREQUENCY', 'BSA_RETENTION_YEARS',
      ].sort(),
    );
  });
});

/** Тоолдог, удирдаж болдог inner provider */
type CountingProvider = BsaSettingsProvider & { calls: string[]; value: BsaSettings; fail: Error | null; delay: Promise<void> | null };
function countingProvider(initial: Partial<BsaSettings> = {}): CountingProvider {
  const self = {
    calls: [] as string[],
    value: { ...clone(), ...initial } as BsaSettings,
    fail: null as Error | null,
    delay: null as Promise<void> | null,
    async get(orgId: string): Promise<BsaSettings> {
      self.calls.push(orgId);
      const snapshot = self.value; // дуудлага эхлэх мөчийн утга (хожим өөрчлөгдсөн ч хуучин fetch хуучнаа буцаана)
      if (self.delay) await self.delay;
      if (self.fail) throw self.fail;
      return snapshot;
    },
  };
  return self;
}

describe('CachedBsaSettingsProvider', () => {
  const setup = (opts: ConstructorParameters<typeof CachedBsaSettingsProvider>[1] = {}) => {
    let now = 1_000_000;
    const inner = countingProvider();
    const cache = new CachedBsaSettingsProvider(inner, { now: () => now, ...opts });
    return { inner, cache, advance: (ms: number) => void (now += ms) };
  };

  it('defaults to a 60-second TTL (CLAUDE.md §3.2(8))', async () => {
    expect(SETTINGS_CACHE_TTL_MS).toBe(60_000);
    const { inner, cache, advance } = setup();
    await cache.get('o');
    advance(59_999);
    await cache.get('o');
    expect(inner.calls).toHaveLength(1);
    advance(1);
    await cache.get('o');
    expect(inner.calls).toHaveLength(2);
  });

  it('caches per organisation', async () => {
    const { inner, cache } = setup();
    await cache.get('o1');
    await cache.get('o2');
    await cache.get('o1');
    await cache.get('o2');
    expect(inner.calls).toEqual(['o1', 'o2']);
  });

  it('picks up changed settings after expiry, not before', async () => {
    const { inner, cache, advance } = setup({ ttlMs: 1_000 });
    expect((await cache.get('o')).maxDti).toBe(0.55);
    inner.value = { ...inner.value, maxDti: 0.4 };
    advance(999);
    expect((await cache.get('o')).maxDti).toBe(0.55);
    advance(1);
    expect((await cache.get('o')).maxDti).toBe(0.4);
  });

  it('shares one fetch between concurrent callers (single-flight)', async () => {
    const { inner, cache } = setup();
    let release!: () => void;
    inner.delay = new Promise<void>((resolve) => (release = resolve));
    const all = Promise.all([cache.get('o'), cache.get('o'), cache.get('o')]);
    release();
    const [a, b, c] = await all;
    expect(inner.calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('does not cache failures; the next call retries and succeeds', async () => {
    const { inner, cache } = setup();
    inner.fail = new Error('origination unavailable');
    await expect(cache.get('o')).rejects.toThrow('origination unavailable');
    await expect(cache.get('o')).rejects.toThrow('origination unavailable');
    inner.fail = null;
    await expect(cache.get('o')).resolves.toMatchObject({ maxDti: 0.55 });
    expect(inner.calls).toHaveLength(3);
  });

  it('after expiry a failing refresh rejects (no silently stale thresholds)', async () => {
    const { inner, cache, advance } = setup({ ttlMs: 10 });
    await cache.get('o');
    advance(10);
    inner.fail = new Error('down');
    await expect(cache.get('o')).rejects.toThrow('down');
  });

  it('turns a synchronous throw of the inner provider into a rejection', async () => {
    const cache = new CachedBsaSettingsProvider({
      get: () => {
        throw new Error('sync boom');
      },
    });
    await expect(cache.get('o')).rejects.toThrow('sync boom');
  });

  it('invalidate(org) and invalidate() force a refetch', async () => {
    const { inner, cache } = setup();
    await cache.get('o1');
    await cache.get('o2');
    cache.invalidate('o1');
    await cache.get('o1');
    await cache.get('o2');
    expect(inner.calls).toEqual(['o1', 'o2', 'o1']);
    cache.invalidate();
    await cache.get('o1');
    await cache.get('o2');
    expect(inner.calls).toEqual(['o1', 'o2', 'o1', 'o1', 'o2']);
  });

  it('a fetch that was already running when invalidate() happened is not cached', async () => {
    const { inner, cache } = setup();
    let release!: () => void;
    inner.delay = new Promise<void>((resolve) => (release = resolve));
    const stale = cache.get('o');
    await Promise.resolve();
    cache.invalidate('o');
    inner.delay = null;
    inner.value = { ...inner.value, maxDti: 0.4 };
    release();
    expect((await stale).maxDti).toBe(0.55); // яваа дуудлага хуучин утгаа авна
    expect((await cache.get('o')).maxDti).toBe(0.4); // харин cache-д хуучин нь үлдээгүй
  });

  it('serves immutable snapshots isolated from the inner provider', async () => {
    const { inner, cache } = setup();
    const first = await cache.get('o');
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first as BsaSettings).maxDti = 0.9;
    }).toThrow(TypeError);
    inner.value.maxDti = 0.9; // inner өөрийн объектыг хожим өөрчилсөн ч cache өөрчлөгдөхгүй
    expect((await cache.get('o')).maxDti).toBe(0.55);
  });

  it('ttl 0 disables caching but still coalesces concurrent calls', async () => {
    const { inner, cache } = setup({ ttlMs: 0 });
    await Promise.all([cache.get('o'), cache.get('o')]);
    await cache.get('o');
    expect(inner.calls).toHaveLength(2);
  });

  it('bounds the number of cached organisations (evicts the oldest)', async () => {
    const { inner, cache } = setup({ maxEntries: 2 });
    await cache.get('o1');
    await cache.get('o2');
    await cache.get('o3'); // o1 гарна
    await cache.get('o2');
    await cache.get('o3');
    expect(inner.calls).toEqual(['o1', 'o2', 'o3']);
    await cache.get('o1');
    expect(inner.calls).toEqual(['o1', 'o2', 'o3', 'o1']);
  });

  it('rejects invalid options', () => {
    const inner = countingProvider();
    expect(() => new CachedBsaSettingsProvider(inner, { ttlMs: -1 })).toThrow(/ttl/);
    expect(() => new CachedBsaSettingsProvider(inner, { ttlMs: Number.NaN })).toThrow(/ttl/);
    expect(() => new CachedBsaSettingsProvider(inner, { maxEntries: 0 })).toThrow(RangeError);
  });
});

describe('OverriddenBsaSettingsProvider (origination.settings seam, TODO(M13))', () => {
  const base = new EnvBsaSettingsProvider({});

  it('returns the base unchanged when the source has nothing for the org', async () => {
    for (const none of [null, undefined]) {
      const p = new OverriddenBsaSettingsProvider(base, { fetch: async () => none });
      await expect(p.get('o')).resolves.toBe(base.settings);
    }
  });

  it('merges partial overrides (nested fields individually, arrays replaced) and re-validates', async () => {
    const fetch = vi.fn(async () => ({
      maxDti: 0.5, dtiLevelThresholds: { lowMax: 0.3 }, allowedPeriodMonths: [6], reliabilityWeights: { frequency: 0.5, consistency: 0.3 },
    }));
    const out = await new OverriddenBsaSettingsProvider(base, { fetch }).get('org-7');
    expect(fetch).toHaveBeenCalledWith('org-7');
    expect(out).toMatchObject({
      maxDti: 0.5,
      dtiLevelThresholds: { lowMax: 0.3, mediumMax: 0.55 },
      allowedPeriodMonths: [6],
      reliabilityWeights: { frequency: 0.5, consistency: 0.3, cleanliness: 0.2 },
      costOfGoodsRate: 0.1,
    });
    expect(Object.isFrozen(out)).toBe(true);
  });

  it.each([
    ['unknown key', { maxdti: 0.5 }, /override .*maxdti/],
    ['out of range', { maxDti: 7 }, /override maxDti/],
    ['cross-field conflict after merge', { dtiLevelThresholds: { lowMax: 0.9 } }, /lowMax \(0\.9\) must be <= mediumMax \(0\.55\)/],
    ['weights no longer sum to 1', { reliabilityWeights: { frequency: 0.9 } }, /weights must sum to 1/],
  ])('rejects an invalid override from the source: %s', async (_n, override, pattern) => {
    const p = new OverriddenBsaSettingsProvider(base, { fetch: async () => override as never });
    await expect(p.get('o')).rejects.toBeInstanceOf(BsaSettingsError);
    await expect(p.get('o')).rejects.toThrow(pattern);
  });

  it('propagates source failures', async () => {
    const p = new OverriddenBsaSettingsProvider(base, { fetch: async () => { throw new Error('GET /settings timed out'); } });
    await expect(p.get('o')).rejects.toThrow('timed out');
  });
});

describe('createBsaSettingsProvider(env)', () => {
  it('builds Cache(Env) with the 60s default TTL', async () => {
    let now = 0;
    const calls: string[] = [];
    const p = createBsaSettingsProvider({ BSA_MAX_DTI: '0.5' }, { now: () => now, source: { fetch: async (org) => (calls.push(org), null) } });
    expect((await p.get('o')).maxDti).toBe(0.5);
    await p.get('o');
    now += 59_999;
    await p.get('o');
    expect(calls).toEqual(['o']);
    now += 1;
    await p.get('o');
    expect(calls).toEqual(['o', 'o']);
  });

  it('BSA_SETTINGS_CACHE_TTL_MS overrides the TTL; source overrides win over env', async () => {
    let now = 0;
    const calls: string[] = [];
    const p = createBsaSettingsProvider(
      { BSA_MAX_DTI: '0.5', BSA_SETTINGS_CACHE_TTL_MS: '1000' },
      { now: () => now, source: { fetch: async (org) => (calls.push(org), { maxDti: 0.45, dtiLevelThresholds: { mediumMax: 0.45 } }) } },
    );
    expect((await p.get('o')).maxDti).toBe(0.45);
    now += 1_000;
    await p.get('o');
    expect(calls).toHaveLength(2);
  });

  it('fails fast on invalid env at creation, before any request', () => {
    expect(() => createBsaSettingsProvider({ BSA_MAX_DTI: 'x' })).toThrow(/BSA_MAX_DTI/);
    expect(() => createBsaSettingsProvider({ BSA_SETTINGS_CACHE_TTL_MS: '-1' })).toThrow(/BSA_SETTINGS_CACHE_TTL_MS/);
  });
});
