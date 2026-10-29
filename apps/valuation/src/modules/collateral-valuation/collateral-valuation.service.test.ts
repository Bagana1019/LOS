import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';
import { DomainEvent, type RecordExternalValuationRequest, type SaveCollateralValuationRequest, type SuggestValuationResponse, type ValuationSuggestion } from '@los/contracts';
import { DomainError, FixedClock } from '@los/nest-common';
import { CollateralValuationService } from './collateral-valuation.service';
import type { CollateralValuationRow, ProjectionInput, ValuationInsert } from './collateral-valuation.repository';
import { CTX } from './testing/fakes';

// FR-14.2, FR-14.3, FR-14.6 — save / external / history rules with an in-memory repository (the DB-backed flow is in collateral-valuation.e2e.test.ts).

const M = 1_000_000;
const NOW = new Date('2026-10-29T03:00:00.000Z'); // 11:00 on 29 Oct in Ulaanbaatar
const COLLATERAL_ID = '11111111-1111-4111-8111-111111111111';
const APPLICATION_ID = '22222222-2222-4222-8222-222222222222';
const REPORT_FILE_ID = '33333333-3333-4333-8333-333333333333';

beforeAll(() => Logger.overrideLogger(false));

const suggestion = (over: Partial<ValuationSuggestion> = {}): ValuationSuggestion => ({
  available: true,
  method: 'REALTY_BASE_PRICE',
  marketValue: 25 * M,
  lowValue: null,
  highValue: null,
  confidence: null,
  basis: { areaM2: 60 },
  warnings: ['DEMO_PARAMETERS'],
  unavailableReason: null,
  ...over,
});
const unavailable = (reason: ValuationSuggestion['unavailableReason'] = 'NO_BASE_PRICE'): ValuationSuggestion =>
  suggestion({ available: false, method: null, marketValue: null, basis: {}, warnings: [], unavailableReason: reason });

class FakeSuggestions {
  calls = 0;
  constructor(public result: SuggestValuationResponse) {}
  async suggest(): Promise<SuggestValuationResponse> {
    this.calls++;
    return this.result;
  }
}

/** Mirrors the Prisma repository: a transaction that throws leaves nothing behind. */
class FakeRepo {
  projections = new Map<string, ProjectionInput & { id: string }>();
  valuations: (ValuationInsert & { id: string })[] = [];
  outbox: { id: string; type: string; payload: Record<string, unknown> }[] = [];
  locks: unknown[][] = [];
  failOutbox = false;
  historyRows: CollateralValuationRow[] = [];
  historyArgs: [string, string][] = [];

  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    const saved = { p: new Map(this.projections), v: [...this.valuations], o: [...this.outbox] };
    const tx = {
      $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        this.locks.push(values);
        return 0;
      },
      outbox: {
        create: async ({ data }: { data: { id: string; type: string; payload: Record<string, unknown> } }) => {
          if (this.failOutbox) throw new Error('outbox down');
          this.outbox.push(data);
        },
      },
    };
    try {
      return await fn(tx);
    } catch (e) {
      this.projections = saved.p;
      this.valuations = saved.v;
      this.outbox = saved.o;
      throw e;
    }
  }
  async upsertProjection(_tx: unknown, p: ProjectionInput): Promise<string> {
    const key = `${p.orgId}:${p.collateralId}`;
    const id = this.projections.get(key)?.id ?? `proj-${this.projections.size + 1}`;
    this.projections.set(key, { ...p, id });
    return id;
  }
  async insertValuation(_tx: unknown, v: ValuationInsert): Promise<CollateralValuationRow> {
    const id = `val-${this.valuations.length + 1}`;
    this.valuations.push({ ...v, id });
    return {
      id, orgId: v.orgId, collateralRefId: v.collateralRefId, source: v.source, appraiser: v.appraiser, valuedAt: v.valuedAt, validUntil: v.validUntil,
      marketValue: v.marketValue, haircutRate: v.haircutRate, collateralValue: v.collateralValue, methodJson: v.methodJson, reportFileId: v.reportFileId,
      overrideReason: v.overrideReason, method: v.method, suggestedValue: v.suggestedValue, haircutSource: v.haircutSource, externalRequired: v.externalRequired,
      licenseNo: v.licenseNo, createdAt: NOW, updatedAt: NOW, createdBy: v.actorId, updatedBy: v.actorId,
    } as unknown as CollateralValuationRow;
  }
  async history(orgId: string, collateralId: string): Promise<CollateralValuationRow[]> {
    this.historyArgs.push([orgId, collateralId]);
    return this.historyRows;
  }
}

function setup(over: { suggestion?: ValuationSuggestion; haircut?: SuggestValuationResponse['haircut']; now?: Date } = {}) {
  const repo = new FakeRepo();
  const suggestions = new FakeSuggestions({
    assetType: 'APARTMENT',
    suggestion: over.suggestion ?? suggestion(),
    haircut: over.haircut ?? { rate: 0.8, source: 'ORG_RULE' },
    manualValueRequired: false,
    externalValuationThreshold: null,
  });
  const service = new CollateralValuationService(suggestions as never, repo as never, new FixedClock(over.now ?? NOW));
  return { service, repo, suggestions };
}

const apartmentDescription = { address: { province: 'Улаанбаатар', district: 'Баянзүрх', detail: 'Гудамж 1, 12 тоот' }, propertyId: 'P-1', areaM2: 60 };
const saveRequest = (over: Partial<SaveCollateralValuationRequest> = {}): SaveCollateralValuationRequest => ({
  collateralId: COLLATERAL_ID,
  applicationId: APPLICATION_ID,
  productId: 'prod-1',
  assetType: 'APARTMENT',
  description: apartmentDescription,
  productHaircutRate: null,
  externalValuationThreshold: null,
  validityDays: 90,
  ...over,
});
const externalRequest = (over: Partial<RecordExternalValuationRequest> = {}): RecordExternalValuationRequest => ({
  collateralId: COLLATERAL_ID,
  applicationId: APPLICATION_ID,
  productId: 'prod-1',
  assetType: 'APARTMENT',
  description: apartmentDescription,
  productHaircutRate: null,
  externalValuationThreshold: null,
  validityDays: 365,
  appraiser: 'Жишээ Үнэлгээ ХХК',
  valuedAt: '2026-10-27',
  marketValue: 120 * M,
  reportFileId: REPORT_FILE_ID,
  ...over,
});

const codeOf = async (p: Promise<unknown>): Promise<{ code: string; status: number; details?: unknown }> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DomainError);
  return { code: (e as DomainError).code, status: (e as DomainError).getStatus(), details: (e as DomainError).details };
};

describe('save (internal valuation)', () => {
  it('docs/04 AC: manual value 30,000,000 × haircut 0.7 = 21,000,000', async () => {
    const { service, repo } = setup({ suggestion: unavailable('MANUAL_VALUE_ASSET'), haircut: { rate: 0.7, source: 'PRODUCT_JSON' } });
    const r = await service.save(CTX, saveRequest({ assetType: 'INVENTORY', marketValue: 30 * M }));
    expect(r.valuation).toMatchObject({ marketValue: 30 * M, haircutRate: 0.7, haircutSource: 'PRODUCT_JSON', collateralValue: 21 * M, source: 'INTERNAL', method: 'INVENTORY_STOCKTAKE', suggestedValue: null, overrideReason: null });
    expect(repo.valuations).toHaveLength(1);
  });

  it('follows the suggestion when no value is sent: method and suggested value come from it, no reason', async () => {
    const { service } = setup();
    const r = await service.save(CTX, saveRequest());
    expect(r.valuation).toMatchObject({ marketValue: 25 * M, suggestedValue: 25 * M, method: 'REALTY_BASE_PRICE', collateralValue: 20 * M, overrideReason: null, haircutRate: 0.8, haircutSource: 'ORG_RULE', source: 'INTERNAL', appraiser: null, reportFileId: null });
    expect(r.suggestion.marketValue).toBe(25 * M);
  });

  it('recomputes the suggestion on the server (never takes the client copy)', async () => {
    const { service, suggestions } = setup();
    await service.save(CTX, saveRequest({ marketValue: 25 * M }));
    expect(suggestions.calls).toBe(1);
  });

  it('a value equal to the suggestion needs no reason and a stray reason is dropped', async () => {
    const { service } = setup();
    const r = await service.save(CTX, saveRequest({ marketValue: 25 * M, overrideReason: 'нэмэлт тайлбар' }));
    expect(r.valuation).toMatchObject({ method: 'REALTY_BASE_PRICE', overrideReason: null });
  });

  it('equal after rounding to 2 decimals counts as equal; a difference of one kopeck does not', async () => {
    const { service } = setup();
    const same = await service.save(CTX, saveRequest({ marketValue: 25 * M + 0.004 }));
    expect(same.valuation).toMatchObject({ marketValue: 25 * M, method: 'REALTY_BASE_PRICE', overrideReason: null });
    expect((await codeOf(service.save(CTX, saveRequest({ marketValue: 25 * M + 0.01 })))).code).toBe('OVERRIDE_REASON_REQUIRED');
  });

  it('rounds the stored market value to 2 decimals and the collateral value too', async () => {
    const { service } = setup({ suggestion: unavailable('MANUAL_VALUE_ASSET'), haircut: { rate: 0.7, source: 'DEMO_DEFAULT' } });
    const r = await service.save(CTX, saveRequest({ assetType: 'OTHER', marketValue: 1000.005 }));
    expect(r.valuation.marketValue).toBe(1000.01);
    expect(r.valuation.collateralValue).toBe(700.01); // 1000.01 × 0.7 = 700.007
  });

  describe('override reason (FR-14.2)', () => {
    it('a value that differs from the suggestion needs a reason (422, nothing stored)', async () => {
      const { service, repo } = setup();
      expect(await codeOf(service.save(CTX, saveRequest({ marketValue: 26 * M })))).toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED', status: 422 });
      expect(repo.valuations).toEqual([]);
      expect(repo.projections.size).toBe(0);
      expect(repo.outbox).toEqual([]);
    });

    it('with a reason it is stored with the suggested value, and the method is MANUAL', async () => {
      const { service } = setup();
      const r = await service.save(CTX, saveRequest({ marketValue: 26 * M, overrideReason: 'Засвартай, зах зээл өндөр' }));
      expect(r.valuation).toMatchObject({ marketValue: 26 * M, suggestedValue: 25 * M, method: 'MANUAL', overrideReason: 'Засвартай, зах зээл өндөр', collateralValue: 20.8 * M });
    });

    it('no suggestion and no value: 422 MARKET_VALUE_REQUIRED (with the reason the suggestion is missing)', async () => {
      const { service, repo } = setup({ suggestion: unavailable('NO_BASE_PRICE') });
      expect(await codeOf(service.save(CTX, saveRequest()))).toMatchObject({ code: 'MARKET_VALUE_REQUIRED', status: 422, details: { unavailableReason: 'NO_BASE_PRICE' } });
      expect(repo.valuations).toEqual([]);
    });

    it('no suggestion, a value but no reason: 422 OVERRIDE_REASON_REQUIRED; with a reason it is saved as MANUAL', async () => {
      const { service } = setup({ suggestion: unavailable('NO_BASE_PRICE') });
      expect(await codeOf(service.save(CTX, saveRequest({ marketValue: 40 * M })))).toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED', status: 422 });
      const r = await service.save(CTX, saveRequest({ marketValue: 40 * M, overrideReason: 'Үнэ тогтоох суурь байхгүй' }));
      expect(r.valuation).toMatchObject({ method: 'MANUAL', suggestedValue: null, overrideReason: 'Үнэ тогтоох суурь байхгүй', marketValue: 40 * M });
    });

    it.each(['INVENTORY', 'EQUIPMENT', 'OTHER'] as const)('%s never needs a reason (the officer always enters the value)', async (assetType) => {
      const { service } = setup({ suggestion: unavailable('MANUAL_VALUE_ASSET') });
      const r = await service.save(CTX, saveRequest({ assetType, marketValue: 5 * M }));
      expect(r.valuation).toMatchObject({ method: assetType === 'INVENTORY' ? 'INVENTORY_STOCKTAKE' : 'MANUAL', overrideReason: null });
    });

    it('a manual-value asset keeps the officer\'s note as the reason', async () => {
      const { service } = setup({ suggestion: unavailable('MANUAL_VALUE_ASSET') });
      const r = await service.save(CTX, saveRequest({ assetType: 'EQUIPMENT', marketValue: 5 * M, overrideReason: 'Тооллогын акт №3' }));
      expect(r.valuation.overrideReason).toBe('Тооллогын акт №3');
    });

    it('a manual-value asset without a value is 422 MARKET_VALUE_REQUIRED', async () => {
      const { service } = setup({ suggestion: unavailable('MANUAL_VALUE_ASSET') });
      expect((await codeOf(service.save(CTX, saveRequest({ assetType: 'OTHER' })))).code).toBe('MARKET_VALUE_REQUIRED');
    });
  });

  it('valuedAt is now and validUntil = valuedAt + validity days', async () => {
    const { service } = setup();
    const r = await service.save(CTX, saveRequest({ validityDays: 30 }));
    expect(r.valuation.valuedAt).toBe('2026-10-29T03:00:00.000Z');
    expect(r.valuation.validUntil).toBe('2026-11-28T03:00:00.000Z');
  });

  it('externalRequired = threshold set and market value >= threshold', async () => {
    const { service } = setup({ suggestion: unavailable('MANUAL_VALUE_ASSET') });
    const at = (v: number, t: number | null) => service.save(CTX, saveRequest({ assetType: 'OTHER', marketValue: v, externalValuationThreshold: t }));
    expect((await at(100 * M, 100 * M)).valuation.externalRequired).toBe(true);
    expect((await at(100 * M + 1, 100 * M)).valuation.externalRequired).toBe(true);
    expect((await at(100 * M - 1, 100 * M)).valuation.externalRequired).toBe(false);
    expect((await at(900 * M, null)).valuation.externalRequired).toBe(false);
  });

  it('writes the projection, the valuation and the ValuationCompleted outbox row; the event fills every optional field', async () => {
    const { service, repo } = setup();
    const r = await service.save(CTX, saveRequest({ externalValuationThreshold: 20 * M }));
    expect([...repo.projections.values()]).toMatchObject([{ orgId: 'org-1', collateralId: COLLATERAL_ID, applicationId: APPLICATION_ID, productId: 'prod-1', assetType: 'APARTMENT', actorId: 'user-1' }]);
    expect(repo.valuations[0]).toMatchObject({ collateralRefId: repo.projections.get(`org-1:${COLLATERAL_ID}`)!.id, actorId: 'user-1' });
    expect(repo.outbox).toHaveLength(1);
    const event = DomainEvent.parse(repo.outbox[0].payload);
    expect(repo.outbox[0]).toMatchObject({ id: event.eventId, type: 'ValuationCompleted' });
    expect(event).toMatchObject({
      type: 'ValuationCompleted',
      version: 1,
      orgId: 'org-1',
      actorId: 'user-1',
      correlationId: 'corr-1',
      occurredAt: NOW.toISOString(),
      collateralId: COLLATERAL_ID,
      applicationId: APPLICATION_ID,
      valuationId: r.valuation.id,
      assetType: 'APARTMENT',
      source: 'INTERNAL',
      marketValue: 25 * M,
      haircutRate: 0.8,
      collateralValue: 20 * M,
      valuedAt: '2026-10-29T03:00:00.000Z',
      validUntil: '2027-01-27T03:00:00.000Z',
      externalRequired: true,
    });
  });

  it('serialises writers of one collateral with an advisory lock taken inside the transaction', async () => {
    const { service, repo } = setup();
    await service.save(CTX, saveRequest());
    expect(repo.locks).toEqual([['collateral_valuation|org-1|' + COLLATERAL_ID]]);
  });

  it('the projection keeps the description without the street address and free-text location', async () => {
    const { service, repo } = setup();
    await service.save(CTX, saveRequest());
    const stored = [...repo.projections.values()][0].descriptionJson as Record<string, unknown>;
    expect(stored).toEqual({ address: { province: 'Улаанбаатар', district: 'Баянзүрх' }, areaM2: 60, purpose: 'RESIDENTIAL' }); // propertyId (identifier) is not stored
    const livestock = setup({ suggestion: unavailable('NO_BASE_PRICE') });
    await livestock.service.save(CTX, saveRequest({ assetType: 'LIVESTOCK', description: { livestockType: 'HORSE', headCount: 3, location: 'Төв аймаг, Алтанбулаг' }, marketValue: 5 * M, overrideReason: 'тооллого' }));
    expect([...livestock.repo.projections.values()][0].descriptionJson).toEqual({ livestockType: 'HORSE', ageGroup: 'ADULT', headCount: 3 });
    // unknown client keys (e.g. a register number smuggled into the free-form description) are not stored
    const junk = setup({ suggestion: unavailable('NO_BASE_PRICE') });
    await junk.service.save(CTX, saveRequest({ assetType: 'LIVESTOCK', description: { livestockType: 'HORSE', headCount: 3, secretRegister: 'УБ12345678' }, marketValue: 5 * M, overrideReason: 'тооллого' }));
    expect([...junk.repo.projections.values()][0].descriptionJson).toEqual({ livestockType: 'HORSE', ageGroup: 'ADULT', headCount: 3 });
    // a sub-cent market value that rounds to 0.00 is not a valuation
    await expect(setup().service.save(CTX, saveRequest({ marketValue: 0.004, overrideReason: 'x' }))).rejects.toMatchObject({ status: 400 });
  });

  it('a second valuation of the same collateral reuses its projection row', async () => {
    const { service, repo } = setup();
    await service.save(CTX, saveRequest());
    await service.save(CTX, saveRequest({ productId: 'prod-2' }));
    expect(repo.projections.size).toBe(1);
    expect(repo.valuations).toHaveLength(2);
    expect(repo.valuations[0].collateralRefId).toBe(repo.valuations[1].collateralRefId);
    expect([...repo.projections.values()][0].productId).toBe('prod-2');
  });

  it('stores the suggestion and the haircut resolution for reproducibility, without personal data', async () => {
    const { service, repo } = setup();
    await service.save(CTX, saveRequest());
    expect(repo.valuations[0].methodJson).toEqual({ suggestion: suggestion(), haircut: { rate: 0.8, source: 'ORG_RULE' } });
  });

  it('is atomic: when the outbox write fails nothing else is kept', async () => {
    const { service, repo } = setup();
    repo.failOutbox = true;
    await expect(service.save(CTX, saveRequest())).rejects.toThrow('outbox down');
    expect(repo.projections.size).toBe(0);
    expect(repo.valuations).toEqual([]);
    expect(repo.outbox).toEqual([]);
  });
});

describe('recordExternal (FR-14.3)', () => {
  it('records the licensed appraiser\'s figure with the report; value × haircut; method EXTERNAL_APPRAISAL', async () => {
    const { service, repo } = setup();
    const r = await service.recordExternal(CTX, externalRequest({ licenseNo: 'LIC-77', note: 'Тайлан хүлээн авсан', externalValuationThreshold: 100 * M }));
    expect(r.valuation).toMatchObject({
      source: 'EXTERNAL_LICENSED',
      method: 'EXTERNAL_APPRAISAL',
      appraiser: 'Жишээ Үнэлгээ ХХК',
      licenseNo: 'LIC-77',
      marketValue: 120 * M,
      suggestedValue: 25 * M,
      haircutRate: 0.8,
      haircutSource: 'ORG_RULE',
      collateralValue: 96 * M,
      overrideReason: null,
      reportFileId: REPORT_FILE_ID,
      externalRequired: true,
    });
    expect(r.suggestion.marketValue).toBe(25 * M);
    expect((repo.valuations[0].methodJson as { note?: string }).note).toBe('Тайлан хүлээн авсан');
    expect(DomainEvent.parse(repo.outbox[0].payload)).toMatchObject({ type: 'ValuationCompleted', source: 'EXTERNAL_LICENSED', marketValue: 120 * M, collateralValue: 96 * M, externalRequired: true, valuationId: r.valuation.id });
  });

  it('keeps the suggested value empty when the system has no suggestion', async () => {
    const { service } = setup({ suggestion: unavailable('NO_BASE_PRICE') });
    const r = await service.recordExternal(CTX, externalRequest());
    expect(r.valuation.suggestedValue).toBeNull();
    expect(r.suggestion.available).toBe(false);
  });

  it('valuedAt is the start of that day in Ulaanbaatar; validUntil defaults to valuedAt + validity days', async () => {
    const { service } = setup();
    const r = await service.recordExternal(CTX, externalRequest({ valuedAt: '2026-10-27', validityDays: 365 }));
    expect(r.valuation.valuedAt).toBe('2026-10-26T16:00:00.000Z');
    expect(r.valuation.validUntil).toBe('2027-10-26T16:00:00.000Z');
  });

  it('an explicit validUntil holds through the whole of that day', async () => {
    const { service } = setup();
    const r = await service.recordExternal(CTX, externalRequest({ valuedAt: '2026-10-27', validUntil: '2027-03-01' }));
    expect(r.valuation.validUntil).toBe('2027-03-01T15:59:59.999Z'); // 23:59:59.999 on 1 March in Ulaanbaatar
  });

  it('a valuation of today is fine; tomorrow is 422 VALUED_AT_IN_FUTURE (the day is the Ulaanbaatar day)', async () => {
    const { service, repo } = setup();
    expect((await service.recordExternal(CTX, externalRequest({ valuedAt: '2026-10-29' }))).valuation.valuedAt).toBe('2026-10-28T16:00:00.000Z');
    expect(await codeOf(service.recordExternal(CTX, externalRequest({ valuedAt: '2026-10-30' })))).toMatchObject({ code: 'VALUED_AT_IN_FUTURE', status: 422 });
    expect(repo.valuations).toHaveLength(1);
    // 04:30 on the 29th in Ulaanbaatar is still the 28th in UTC: the 29th is today for the officer
    const early = setup({ now: new Date('2026-10-28T20:30:00.000Z') });
    await expect(early.service.recordExternal(CTX, externalRequest({ valuedAt: '2026-10-29' }))).resolves.toBeDefined();
  });

  it('validUntil must be after valuedAt', async () => {
    const { service, repo } = setup();
    for (const validUntil of ['2026-10-27', '2026-10-26', '2025-01-01']) {
      expect(await codeOf(service.recordExternal(CTX, externalRequest({ valuedAt: '2026-10-27', validUntil })))).toMatchObject({ code: 'VALID_UNTIL_INVALID', status: 422 });
    }
    await expect(service.recordExternal(CTX, externalRequest({ valuedAt: '2026-10-27', validUntil: '2026-10-28' }))).resolves.toBeDefined();
    expect(repo.valuations).toHaveLength(1);
  });

  it('rejects calendar dates that do not exist (400)', async () => {
    const { service } = setup();
    expect(await codeOf(service.recordExternal(CTX, externalRequest({ valuedAt: '2026-02-31' })))).toMatchObject({ code: 'VALIDATION_FAILED', status: 400, details: [{ path: 'valuedAt' }] });
    expect(await codeOf(service.recordExternal(CTX, externalRequest({ validUntil: '2027-13-01' })))).toMatchObject({ code: 'VALIDATION_FAILED', status: 400, details: [{ path: 'validUntil' }] });
  });

  it('is atomic like save', async () => {
    const { service, repo } = setup();
    repo.failOutbox = true;
    await expect(service.recordExternal(CTX, externalRequest())).rejects.toThrow('outbox down');
    expect(repo.valuations).toEqual([]);
    expect(repo.projections.size).toBe(0);
  });
});

describe('history (FR-14.6)', () => {
  it('maps the rows in the order the repository gives (newest first) and passes the org and collateral', async () => {
    const { service, repo } = setup();
    await service.save(CTX, saveRequest());
    await service.save(CTX, saveRequest({ marketValue: 26 * M, overrideReason: 'x yz' }));
    const rows = await Promise.all(repo.valuations.map((v) => repo.insertValuation(null, v)));
    repo.historyRows = [rows[1], rows[0]];
    const h = await service.history(CTX, COLLATERAL_ID);
    expect(h.items.map((i) => i.marketValue)).toEqual([26 * M, 25 * M]);
    expect(h.items.every((i) => i.collateralId === COLLATERAL_ID)).toBe(true);
    expect(repo.historyArgs).toEqual([['org-1', COLLATERAL_ID]]);
  });

  it('no rows → empty history', async () => {
    const { service } = setup();
    expect(await service.history(CTX, COLLATERAL_ID)).toEqual({ items: [] });
  });
});
