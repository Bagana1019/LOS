import { describe, expect, it } from 'vitest';
import { GateIssueCode, type ValuationSuggestion } from '@los/contracts';
import { hasMessage } from '../../lib/i18n';
import {
  buildExternalValuationRequest, buildRegisterPledgeRequest, buildSaveValuationRequest, checklistProgress, defaultOwnerId, describeIssue, encumbranceMethods, encumbranceStatus,
  gateState, isDemoSuggestion, ISSUE_SEVERITY, ISSUE_TARGET, ltvTone, overrideReasonRequired, ownerOptions, ownershipMethods, ownershipStatus, sortIssues, stepHref, toFieldErrors,
  valuationStatus,
} from './collateral.utils';
import { IDS, makeBorrower, makeChecklist, makeCollateral, makeEncumbrance, makeIssue, makeOwnership, makeSummary, makeValuation } from './collateral.fixtures';

const suggestion = (overrides: Partial<ValuationSuggestion> = {}): ValuationSuggestion => ({
  available: true,
  method: 'VEHICLE_MARKET_COMPARABLES',
  marketValue: 20_000_000,
  lowValue: 18_000_000,
  highValue: 22_000_000,
  confidence: 'MEDIUM',
  basis: {},
  warnings: [],
  unavailableReason: null,
  ...overrides,
});

describe('G0 дутагдлын код бүр', () => {
  it.each(GateIssueCode.map((c) => [c]))('%s: гарчиг, зөвлөмж, зорилт, түвшин тодорхой', (code) => {
    expect(hasMessage(`collateral.issue.${code}.title`)).toBe(true);
    expect(hasMessage(`collateral.issue.${code}.hint`)).toBe(true);
    expect(ISSUE_SEVERITY[code]).toMatch(/^(error|warning)$/);
    expect(ISSUE_TARGET[code]).toBeDefined();
    const described = describeIssue(makeIssue(code, IDS.vehicle, 'API мессеж'));
    expect(described.title).not.toBe(`collateral.issue.${code}.title`);
    expect(described.title).not.toBe('API мессеж'); // i18n гарчиг давамгайлна
    expect(described.message).toBe('API мессеж'); // API-ийн мессеж тодруулга болж үлдэнэ
    expect(described.hint).not.toBeNull();
    expect(described.target).toEqual(ISSUE_TARGET[code]);
  });

  it('хүсэлтийн түвшний дутагдлууд өөр алхам руу, барьцааных табруу', () => {
    expect(ISSUE_TARGET.LTV_EXCEEDED).toEqual({ kind: 'tab', tab: 'valuation' });
    expect(ISSUE_TARGET.NO_COLLATERAL).toEqual({ kind: 'add' });
    expect(ISSUE_TARGET.LOAN_AMOUNT_MISSING).toEqual({ kind: 'step', step: 'loan' });
    expect(ISSUE_TARGET.OWNER_NOT_ON_APPLICATION).toEqual({ kind: 'step', step: 'client' });
  });

  it('API-ийн мессеж гарчигтай ижил байвал давхардуулахгүй; үл мэдэгдэх код API мессежээр', () => {
    const unknown = describeIssue({ code: 'BRAND_NEW' as never, collateralId: null, message: 'Шинэ шалтгаан' });
    expect(unknown).toMatchObject({ title: 'Шинэ шалтгаан', message: null, hint: null, severity: 'warning', target: null });
  });

  it('sortIssues: хүсэлтийн түвшин эхэнд, дараа нь барьцааны дарааллаар', () => {
    const issues = [
      makeIssue('NOT_VALUED', 'c2'),
      makeIssue('OWNERSHIP_NOT_CHECKED', 'c1'),
      makeIssue('LTV_EXCEEDED'),
      makeIssue('ENCUMBRANCE_NOT_CHECKED', 'c1'),
      makeIssue('NOT_VALUED', 'gone'),
    ];
    expect(sortIssues(issues, ['c1', 'c2']).map((i) => `${i.code}:${i.collateralId ?? '-'}`)).toEqual([
      'LTV_EXCEEDED:-', 'OWNERSHIP_NOT_CHECKED:c1', 'ENCUMBRANCE_NOT_CHECKED:c1', 'NOT_VALUED:c2', 'NOT_VALUED:gone',
    ]);
  });
});

describe('төлвийн шошго', () => {
  it('өмчлөл', () => {
    expect(ownershipStatus(makeCollateral())).toEqual({ tone: 'warning', textKey: 'collateral.status.ownership.NOT_CHECKED' });
    expect(ownershipStatus(makeCollateral({ ownership: makeOwnership() }))).toEqual({ tone: 'success', textKey: 'collateral.status.ownership.VERIFIED' });
    expect(ownershipStatus(makeCollateral({ ownership: makeOwnership(), issues: [makeIssue('OWNERSHIP_STALE', IDS.vehicle)] }))).toEqual({ tone: 'warning', textKey: 'collateral.status.ownership.STALE' });
    expect(ownershipStatus(makeCollateral({ ownership: makeOwnership({ status: 'OWNER_MISMATCH' }) }))).toEqual({ tone: 'error', textKey: 'collateral.status.ownership.OWNER_MISMATCH' });
    expect(ownershipStatus(makeCollateral({ ownership: makeOwnership({ status: 'OWNER_NOT_ON_APPLICATION' }) })).textKey).toBe('collateral.status.ownership.OWNER_NOT_ON_APPLICATION');
  });
  it('ачаалал', () => {
    expect(encumbranceStatus(makeCollateral())).toEqual({ tone: 'warning', textKey: 'collateral.status.encumbrance.NOT_CHECKED' });
    expect(encumbranceStatus(makeCollateral({ encumbrance: makeEncumbrance() }))).toEqual({ tone: 'success', textKey: 'collateral.status.encumbrance.CLEAR' });
    expect(encumbranceStatus(makeCollateral({ encumbrance: makeEncumbrance(), issues: [makeIssue('ENCUMBRANCE_STALE', IDS.vehicle)] })).textKey).toBe('collateral.status.encumbrance.STALE');
    expect(encumbranceStatus(makeCollateral({ encumbrance: makeEncumbrance({ status: 'ENCUMBERED' }) }))).toEqual({ tone: 'error', textKey: 'collateral.status.encumbrance.ENCUMBERED' });
    expect(encumbranceStatus(makeCollateral({ encumbrance: makeEncumbrance({ status: 'DISPUTED' }) })).tone).toBe('error');
  });
  it('үнэлгээ', () => {
    expect(valuationStatus({ valuation: null }).textKey).toBe('collateral.status.valuation.NOT_VALUED');
    expect(valuationStatus({ valuation: makeValuation() })).toEqual({ tone: 'success', textKey: 'collateral.status.valuation.VALUED' });
    expect(valuationStatus({ valuation: makeValuation({ source: 'EXTERNAL_LICENSED' }) }).textKey).toBe('collateral.status.valuation.EXTERNAL');
    expect(valuationStatus({ valuation: makeValuation({ expired: true }) })).toEqual({ tone: 'error', textKey: 'collateral.status.valuation.EXPIRED' });
    expect(valuationStatus({ valuation: makeValuation({ externalRequired: true, externalSatisfied: false }) })).toEqual({ tone: 'warning', textKey: 'collateral.status.valuation.EXTERNAL_REQUIRED' });
    expect(valuationStatus({ valuation: makeValuation({ externalRequired: true, externalSatisfied: true, source: 'EXTERNAL_LICENSED' }) }).tone).toBe('success');
  });
  it('төлөв бүрийн орчуулга бий', () => {
    const keys = [
      ...['NOT_CHECKED', 'STALE', 'VERIFIED', 'OWNER_MISMATCH', 'OWNER_NOT_ON_APPLICATION'].map((s) => `collateral.status.ownership.${s}`),
      ...['NOT_CHECKED', 'STALE', 'CLEAR', 'ENCUMBERED', 'DISPUTED'].map((s) => `collateral.status.encumbrance.${s}`),
      ...['NOT_VALUED', 'EXPIRED', 'EXTERNAL_REQUIRED', 'EXTERNAL', 'VALUED'].map((s) => `collateral.status.valuation.${s}`),
    ];
    for (const key of keys) expect(hasMessage(key), key).toBe(true);
  });
  it('checklistProgress: зөвхөн заавал мөрүүд', () => {
    const checklist = makeChecklist([
      { key: 'a', required: true, satisfied: true },
      { key: 'b', required: true, satisfied: false },
      { key: 'c', required: false, satisfied: false },
    ]);
    expect(checklistProgress({ checklist })).toEqual({ required: 2, satisfied: 1, complete: false });
    expect(checklistProgress({ checklist: [] })).toEqual({ required: 0, satisfied: 0, complete: true });
  });
  it('gateState / ltvTone', () => {
    expect(gateState({ complete: true, skipped: false })).toBe('complete');
    expect(gateState({ complete: true, skipped: true })).toBe('skipped');
    expect(gateState({ complete: false, skipped: false })).toBe('incomplete');
    expect(ltvTone(makeSummary({ ltvPass: true }))).toBe('success');
    expect(ltvTone(makeSummary({ ltvPass: false }))).toBe('error');
    expect(ltvTone(makeSummary({ ltvPass: null }))).toBe('default');
  });
  it('stepHref', () => {
    expect(stepHref('a/b', 'client')).toBe('/los/loan-application/a%2Fb/client');
  });
});

describe('шалгалтын арга (өмчлөл, ачаалал)', () => {
  it('бүртгэлтэй төрөл: өмчлөл бүртгэлээс', () => {
    for (const a of ['VEHICLE', 'APARTMENT', 'HOUSE', 'LAND'] as const) expect(ownershipMethods(a)).toEqual(['REGISTRY']);
    for (const a of ['LIVESTOCK', 'INVENTORY', 'EQUIPMENT', 'OTHER'] as const) expect(ownershipMethods(a)).toEqual(['DECLARED']);
  });
  it('ачаалал: бүртгэлтэй төрөлд ЗЭЗ-ийн баталгаа байхгүй; тоног төхөөрөмж хоёулаа', () => {
    expect(encumbranceMethods('VEHICLE')).toEqual(['REGISTRY']);
    expect(encumbranceMethods('LAND')).toEqual(['REGISTRY']);
    expect(encumbranceMethods('EQUIPMENT')).toEqual(['REGISTRY', 'DECLARED']);
    expect(encumbranceMethods('LIVESTOCK')).toEqual(['DECLARED']);
    expect(encumbranceMethods('INVENTORY')).toEqual(['DECLARED']);
  });
});

describe('өмчлөгч сонгох', () => {
  const primary = makeBorrower();
  const guarantor = makeBorrower({ id: 'b2', customerId: IDS.guarantor, role: 'GUARANTOR', isPrimary: false, name: 'Дорж Батаа' });
  const pledgor = makeBorrower({ id: 'b3', customerId: IDS.pledgor, role: 'PLEDGOR', isPrimary: false, name: 'Сараа Дулам' });

  it('батлан даагч ганцаараа өмчлөгч болохгүй; барьцаалагч дүртэй бол болно', () => {
    const options = ownerOptions([guarantor, primary, pledgor]);
    expect(options.map((o) => [o.customerId, o.eligible])).toEqual([[IDS.owner, true], [IDS.pledgor, true], [IDS.guarantor, false]]);
  });
  it('нэг харилцагчийн хэд хэдэн дүрийг нэгтгэнэ', () => {
    const guarantorAndPledgor = makeBorrower({ id: 'b4', customerId: IDS.guarantor, role: 'PLEDGOR', isPrimary: false, name: 'Дорж Батаа' });
    const options = ownerOptions([guarantor, guarantorAndPledgor]);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ customerId: IDS.guarantor, roles: ['PLEDGOR', 'GUARANTOR'], eligible: true });
  });
  it('defaultOwnerId: үндсэн зээлдэгч; үгүй бол ганц боломжит; бусад үед сонгохгүй', () => {
    expect(defaultOwnerId(ownerOptions([primary, pledgor]))).toBe(IDS.owner);
    expect(defaultOwnerId(ownerOptions([guarantor, pledgor]))).toBe(IDS.pledgor);
    expect(defaultOwnerId(ownerOptions([makeBorrower({ role: 'CO_BORROWER' }), pledgor]))).toBeUndefined();
    expect(defaultOwnerId(ownerOptions([guarantor]))).toBeUndefined();
    expect(defaultOwnerId([])).toBeUndefined();
  });
});

describe('overrideReasonRequired (FR-14.2)', () => {
  const base = { manualValueRequired: false, suggestion: suggestion() };
  it('саналтай ижил дүн: шаардахгүй', () => expect(overrideReasonRequired({ ...base, marketValue: 20_000_000 })).toBe(false));
  it('саналаас ялгаатай: шаардана', () => expect(overrideReasonRequired({ ...base, marketValue: 19_000_000 })).toBe(true));
  it('дүн оруулаагүй: шаардахгүй', () => {
    expect(overrideReasonRequired({ ...base, marketValue: undefined })).toBe(false);
    expect(overrideReasonRequired({ ...base, marketValue: Number.NaN })).toBe(false);
  });
  it('гараар оруулдаг төрөл: шаардахгүй', () => expect(overrideReasonRequired({ manualValueRequired: true, suggestion: null, marketValue: 5 })).toBe(false));
  it('санал байхгүй/боломжгүй: консерватив — шаардана', () => {
    expect(overrideReasonRequired({ manualValueRequired: false, suggestion: null, marketValue: 5 })).toBe(true);
    expect(overrideReasonRequired({ manualValueRequired: false, suggestion: suggestion({ available: false, marketValue: null }), marketValue: 5 })).toBe(true);
  });
});

describe('buildSaveValuationRequest', () => {
  const draft = { assetType: 'VEHICLE' as const, marketValue: 20_000_000, overrideReason: '', mileageKm: undefined, suggestion: suggestion(), manualValueRequired: false };

  it('саналыг өөрчлөөгүй: marketValue илгээхгүй (сервер өөрийн саналыг хэрэглэнэ)', () => {
    expect(buildSaveValuationRequest(draft)).toEqual({ ok: true, body: {} });
  });
  it('гүйлт: зөвхөн автомашинд', () => {
    expect(buildSaveValuationRequest({ ...draft, mileageKm: 120000 })).toEqual({ ok: true, body: { mileageKm: 120000 } });
    expect(buildSaveValuationRequest({ ...draft, assetType: 'APARTMENT', mileageKm: 120000 })).toEqual({ ok: true, body: {} });
  });
  it('санал өөрчилсөн, шалтгаангүй: overrideReason талбарт алдаа', () => {
    const r = buildSaveValuationRequest({ ...draft, marketValue: 18_500_000 });
    expect(r).toEqual({ ok: false, errors: [{ field: 'overrideReason', message: 'Системийн саналаас өөр дүн оруулсан тул шалтгааныг заавал бичнэ' }] });
  });
  it('шалтгаан хэт богино (< 3 тэмдэгт)', () => {
    const r = buildSaveValuationRequest({ ...draft, marketValue: 18_500_000, overrideReason: ' а ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatchObject({ field: 'overrideReason', message: 'Хамгийн багадаа 3 тэмдэгт байна' });
  });
  it('санал өөрчилсөн, шалтгаантай: хоёулаа илгээнэ (trim)', () => {
    expect(buildSaveValuationRequest({ ...draft, marketValue: 18_500_000, overrideReason: '  Хуучин, будагтай  ' })).toEqual({ ok: true, body: { marketValue: 18_500_000, overrideReason: 'Хуучин, будагтай' } });
  });
  it('санал байхгүй: дүн заавал; шалтгаан заавал', () => {
    const none = { ...draft, suggestion: suggestion({ available: false, marketValue: null, method: null, confidence: null, unavailableReason: 'NO_BASE_PRICE' }) };
    expect(buildSaveValuationRequest({ ...none, marketValue: undefined })).toEqual({ ok: false, errors: [{ field: 'marketValue', message: 'Зах зээлийн үнийг оруулна уу' }] });
    const noReason = buildSaveValuationRequest({ ...none, marketValue: 9_000_000 });
    expect(noReason.ok).toBe(false);
    expect(buildSaveValuationRequest({ ...none, marketValue: 9_000_000, overrideReason: 'Зарын жишиг' })).toEqual({ ok: true, body: { marketValue: 9_000_000, overrideReason: 'Зарын жишиг' } });
  });
  it('гараар оруулдаг төрөл (бараа): дүн заавал, шалтгаан шаардахгүй', () => {
    const manual = { assetType: 'INVENTORY' as const, marketValue: 8_000_000, overrideReason: '', mileageKm: undefined, suggestion: null, manualValueRequired: true };
    expect(buildSaveValuationRequest(manual)).toEqual({ ok: true, body: { marketValue: 8_000_000 } });
    expect(buildSaveValuationRequest({ ...manual, marketValue: null }).ok).toBe(false);
  });
  it('схемээс хэтэрсэн дүн (> 1e12) → marketValue дээр алдаа', () => {
    const r = buildSaveValuationRequest({ ...draft, marketValue: 2e12, overrideReason: 'Тест' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe('marketValue');
  });
});

describe('саналын тусламж', () => {
  it('DEMO тэмдэглэгээ: параметр эсвэл haircut-ийн анхдагч эх сурвалж', () => {
    expect(isDemoSuggestion(suggestion({ warnings: ['DEMO_PARAMETERS'] }), 'PRODUCT_RULE')).toBe(true);
    expect(isDemoSuggestion(suggestion(), 'DEMO_DEFAULT')).toBe(true);
    expect(isDemoSuggestion(suggestion(), 'PRODUCT_RULE')).toBe(false);
    expect(isDemoSuggestion(suggestion(), null)).toBe(false);
  });
  it('toFieldErrors', () => {
    expect(toFieldErrors([{ field: 'marketValue', message: 'x' }])).toEqual([{ name: ['marketValue'], message: 'x' }]);
  });
});

describe('buildExternalValuationRequest', () => {
  const values = { appraiser: ' Үнэлгээ ХХК ', licenseNo: '', valuedAt: '2026-10-20', validUntil: '', marketValue: 25_000_000, note: '  ' };
  it('тайлангийн файл заавал', () => {
    const r = buildExternalValuationRequest(values, null);
    expect(r).toEqual({ ok: false, errors: [{ name: ['reportFileId'], message: 'Үнэлгээний тайлангийн файлыг оруулна уу' }] });
  });
  it('хүчинтэй хүсэлт: хоосон талбаргүй', () => {
    const r = buildExternalValuationRequest(values, IDS.report);
    expect(r).toEqual({ ok: true, body: { appraiser: 'Үнэлгээ ХХК', valuedAt: '2026-10-20', marketValue: 25_000_000, reportFileId: IDS.report } });
  });
  it('дутуу талбар монгол алдаатай', () => {
    const r = buildExternalValuationRequest({ marketValue: null }, IDS.report);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.name[0]).sort()).toEqual(['appraiser', 'marketValue', 'valuedAt']);
      expect(r.errors.every((e) => /[Ѐ-ӿ]/.test(e.message))).toBe(true);
    }
  });
});

describe('buildRegisterPledgeRequest', () => {
  it('ЭБ-ийн дугаар, огноо заавал', () => {
    expect(buildRegisterPledgeRequest({ registryNo: ' EB-2026-1 ', registryDate: '2026-10-29' })).toEqual({ ok: true, body: { registryNo: 'EB-2026-1', registryDate: '2026-10-29' } });
    const r = buildRegisterPledgeRequest({ registryNo: '', registryDate: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.name[0]).sort()).toEqual(['registryDate', 'registryNo']);
  });
});
