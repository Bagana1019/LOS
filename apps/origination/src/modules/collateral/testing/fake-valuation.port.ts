import { randomUUID } from 'node:crypto';
import { DomainError } from '@los/nest-common';
import {
  normalizePlateNo,
  type CollateralValuationRecord, type RecordExternalValuationRequest, type RequestContext, type SaveCollateralValuationRequest, type SaveCollateralValuationResponse,
  type SuggestValuationRequest, type SuggestValuationResponse, type ValuationHistoryResponse, type ValuationSuggestion, type VehicleInfo, type VehicleLookupResponse,
} from '@los/contracts';
import type { ValuationPort } from '../ports/valuation.port';

const MANUAL_TYPES = ['INVENTORY', 'EQUIPMENT', 'OTHER'];
/** DEMO: valuation-ий DEMO default haircut (docs/05 §9) — product.haircut_json байхгүй үед. */
const DEMO_HAIRCUT = 0.5;

/**
 * Тестийн ValuationPort: valuation-ий FR-14 дүрмийг хялбарчилж дууриана (системийн санал → ЗЭЗ засвал шалтгаан заавал → haircut → хүчинтэй хугацаа → гадны босго).
 * `suggestions` — хөрөнгө бүрийн (collateralId) системийн санал; байхгүй бол `defaultSuggestion` (VEHICLE, үл хөдлөх) эсвэл санал байхгүй (ЗЭЗ оруулна).
 */
export class FakeValuationPort implements ValuationPort {
  readonly vehicles = new Map<string, VehicleInfo>();
  readonly records: CollateralValuationRecord[] = [];
  readonly saveRequests: SaveCollateralValuationRequest[] = [];
  readonly externalRequests: RecordExternalValuationRequest[] = [];
  readonly suggestRequests: SuggestValuationRequest[] = [];
  readonly calls: string[] = [];
  suggestions = new Map<string, number>();
  defaultSuggestion = 30_000_000;
  failWith: Error | null = null;
  now: () => Date = () => new Date();
  reset(): void {
    this.vehicles.clear();
    this.records.length = 0;
    this.saveRequests.length = 0;
    this.externalRequests.length = 0;
    this.suggestRequests.length = 0;
    this.calls.length = 0;
    this.suggestions = new Map();
    this.defaultSuggestion = 30_000_000;
    this.failWith = null;
  }

  private maybeFail(): void {
    if (this.failWith) throw this.failWith;
  }

  async lookupVehicle(_ctx: RequestContext, plateNo: string): Promise<VehicleLookupResponse> {
    this.calls.push('lookupVehicle');
    this.maybeFail();
    const v = this.vehicles.get(normalizePlateNo(plateNo));
    if (!v) throw new DomainError('REGISTRY_RECORD_NOT_FOUND', 'Энэ улсын дугаартай тээврийн хэрэгсэл бүртгэлд олдсонгүй. Дугаараа шалгаад дахин оролдоно уу', 422);
    return { vehicle: v, fetchedAt: this.now().toISOString() };
  }

  private suggestionOf(req: SuggestValuationRequest): ValuationSuggestion {
    const manual = MANUAL_TYPES.includes(req.assetType);
    const value = manual ? null : this.suggestions.get(req.collateralId) ?? this.defaultSuggestion;
    return {
      available: value != null, method: value == null ? null : req.assetType === 'VEHICLE' ? 'VEHICLE_BASE_PRICE' : 'REALTY_BASE_PRICE', marketValue: value, lowValue: value, highValue: value,
      confidence: value == null ? null : 'MEDIUM', basis: {}, warnings: ['DEMO_PARAMETERS'], unavailableReason: value == null ? 'MANUAL_VALUE_ASSET' : null,
    };
  }

  private haircutOf(req: SuggestValuationRequest) {
    return req.productHaircutRate != null ? { rate: req.productHaircutRate, source: 'PRODUCT_JSON' as const } : { rate: DEMO_HAIRCUT, source: 'DEMO_DEFAULT' as const };
  }

  async suggest(_ctx: RequestContext, req: SuggestValuationRequest): Promise<SuggestValuationResponse> {
    this.calls.push('suggest');
    this.suggestRequests.push(req);
    this.maybeFail();
    return {
      assetType: req.assetType, suggestion: this.suggestionOf(req), haircut: this.haircutOf(req), manualValueRequired: MANUAL_TYPES.includes(req.assetType),
      externalValuationThreshold: req.externalValuationThreshold,
    };
  }

  async save(_ctx: RequestContext, req: SaveCollateralValuationRequest): Promise<SaveCollateralValuationResponse> {
    this.calls.push('save');
    this.saveRequests.push(req);
    this.maybeFail();
    const suggestion = this.suggestionOf(req);
    const marketValue = req.marketValue ?? suggestion.marketValue;
    if (marketValue == null) throw new DomainError('MARKET_VALUE_REQUIRED', 'Зах зээлийн үнийг оруулна уу (систем санал болгох боломжгүй)', 422);
    const manual = MANUAL_TYPES.includes(req.assetType);
    if (!manual && req.overrideReason == null && (suggestion.marketValue == null || marketValue !== suggestion.marketValue))
      throw new DomainError('OVERRIDE_REASON_REQUIRED', 'Системийн саналаас өөр дүн оруулсан тул шалтгаан заавал бичнэ', 422);
    const haircut = this.haircutOf(req);
    const valuedAt = this.now();
    const record: CollateralValuationRecord = {
      id: randomUUID(), collateralId: req.collateralId, source: 'INTERNAL', method: manual ? 'MANUAL' : req.assetType === 'VEHICLE' ? 'VEHICLE_BASE_PRICE' : 'REALTY_BASE_PRICE',
      appraiser: null, licenseNo: null, valuedAt: valuedAt.toISOString(), validUntil: new Date(valuedAt.getTime() + req.validityDays * 86_400_000).toISOString(),
      marketValue, suggestedValue: suggestion.marketValue, haircutRate: haircut.rate, haircutSource: haircut.source, collateralValue: Math.round(marketValue * haircut.rate * 100) / 100,
      overrideReason: req.overrideReason ?? null, reportFileId: null, externalRequired: req.externalValuationThreshold != null && marketValue >= req.externalValuationThreshold, createdBy: null,
    };
    this.records.push(record);
    return { valuation: record, suggestion };
  }

  async recordExternal(_ctx: RequestContext, req: RecordExternalValuationRequest): Promise<CollateralValuationRecord> {
    this.calls.push('recordExternal');
    this.externalRequests.push(req);
    this.maybeFail();
    const haircut = this.haircutOf(req);
    const valuedAt = new Date(`${req.valuedAt}T00:00:00.000Z`);
    const record: CollateralValuationRecord = {
      id: randomUUID(), collateralId: req.collateralId, source: 'EXTERNAL_LICENSED', method: 'EXTERNAL_APPRAISAL', appraiser: req.appraiser, licenseNo: req.licenseNo ?? null,
      valuedAt: valuedAt.toISOString(), validUntil: req.validUntil ? new Date(`${req.validUntil}T00:00:00.000Z`).toISOString() : new Date(valuedAt.getTime() + req.validityDays * 86_400_000).toISOString(),
      marketValue: req.marketValue, suggestedValue: null, haircutRate: haircut.rate, haircutSource: haircut.source, collateralValue: Math.round(req.marketValue * haircut.rate * 100) / 100,
      overrideReason: null, reportFileId: req.reportFileId, externalRequired: req.externalValuationThreshold != null && req.marketValue >= req.externalValuationThreshold, createdBy: null,
    };
    this.records.push(record);
    return record;
  }

  async history(_ctx: RequestContext, collateralId: string): Promise<ValuationHistoryResponse> {
    this.calls.push('history');
    this.maybeFail();
    return { items: this.records.filter((r) => r.collateralId === collateralId).reverse() };
  }
}
