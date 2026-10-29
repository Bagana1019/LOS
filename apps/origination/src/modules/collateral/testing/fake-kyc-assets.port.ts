import { DomainError } from '@los/nest-common';
import {
  normalizeRegisterNo,
  type EncumbranceCheckRequest, type EncumbranceCheckResult, type RequestContext, type XypAssetsResponse, type XypPropertyAsset,
} from '@los/contracts';
import type { KycAssetsPort } from '../ports/kyc-assets.port';

/**
 * Тестийн KycAssetsPort: kyc-ийн mock fixture-ийн дүрмийг дууриана — ачаалал: идентификаторын СҮҮЛИЙН цифр 7 → ENCUMBERED (ЗМС), 9 → DISPUTED (ЭБ), бусад CLEAR.
 * Дуудлагын түүх `calls`-д (регистрийн утга ОРНО — зөвхөн тестэд).
 */
export class FakeKycAssetsPort implements KycAssetsPort {
  readonly assets = new Map<string, XypAssetsResponse>();
  readonly properties = new Map<string, XypPropertyAsset>();
  readonly calls: Array<{ op: 'assets' | 'property' | 'encumbrance'; arg: unknown; ctx: RequestContext }> = [];
  /** Дараагийн дуудлага(ууд)ад шидэх алдаа. */
  failWith: DomainError | Error | null = null;
  now: () => Date = () => new Date();

  reset(): void {
    this.assets.clear();
    this.properties.clear();
    this.calls.length = 0;
    this.failWith = null;
  }

  private maybeFail(): void {
    if (this.failWith) throw this.failWith;
  }

  async fetchAssets(ctx: RequestContext, registerNo: string): Promise<XypAssetsResponse> {
    this.calls.push({ op: 'assets', arg: registerNo, ctx });
    this.maybeFail();
    return this.assets.get(normalizeRegisterNo(registerNo)) ?? { properties: [], vehicles: [], fetchedAt: this.now().toISOString() };
  }

  async fetchProperty(ctx: RequestContext, propertyId: string): Promise<XypPropertyAsset> {
    this.calls.push({ op: 'property', arg: propertyId, ctx });
    this.maybeFail();
    const p = this.properties.get(propertyId);
    if (!p) throw new DomainError('REGISTRY_RECORD_NOT_FOUND', 'ХУР-д ийм өмчлөх эрхийн дугаар олдсонгүй. Дугаараа шалгана уу', 422);
    return p;
  }

  async checkEncumbrance(ctx: RequestContext, req: EncumbranceCheckRequest): Promise<EncumbranceCheckResult> {
    this.calls.push({ op: 'encumbrance', arg: req, ctx });
    this.maybeFail();
    const last = req.identifier.trim().slice(-1);
    const checkedAt = this.now().toISOString();
    const clear = (source: 'ZMS' | 'EB') => ({ source, status: 'CLEAR' as const, pledgee: null, registeredAt: null, note: null });
    if (last === '7') return { status: 'ENCUMBERED', checkedAt, sources: [{ source: 'ZMS', status: 'ENCUMBERED', pledgee: 'Жишээ ББСБ', registeredAt: '2025-01-15', note: null }, clear('EB')] };
    if (last === '9') return { status: 'DISPUTED', checkedAt, sources: [clear('ZMS'), { source: 'EB', status: 'DISPUTED', pledgee: null, registeredAt: null, note: 'Маргаантай' }] };
    return { status: 'CLEAR', checkedAt, sources: [clear('ZMS'), clear('EB')] };
  }
}
