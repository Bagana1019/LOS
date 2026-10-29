import {
  AttachCollateralDocumentRequest, CreateCollateralRequest, ExternalValuationRequest, OwnershipCheckRequest, RegisterPledgeRequest, RunEncumbranceCheckRequest, SaveValuationRequest,
  collateralKindOf,
  type BorrowerView, type CollateralCandidate, type CollateralDocumentView, type CollateralMutationResponse, type CollateralValuationRecord, type CollateralView, type GateIssue,
  type SuggestValuationResponse,
} from '@los/contracts';
import {
  IDS, NOW, makeBorrower, makeBorrowerList, makeChecklist, makeCollateral, makeEncumbrance, makeList, makeMutation, makeOwnership, makeSummary, makeValuation,
} from '../src/features/collateral/collateral.fixtures';
import type { MockApi, MockReply, MockRequest } from './mock-api';

// Барьцааны алхмын e2e: origination-ийн холбогдох endpoint-уудыг санах ойн төлөвтэй дууриана. Дүрэм (G0, LTV, haircut, үнэлгээний шалтгаан) ЭНД, "сервер" талд —
// UI нь зөвхөн харуулна; тестүүд UI-ийн харуулсан дүн нь API-ийнхтай ижил (өөрөө тооцоолоогүй) гэдгийг шалгана.

export interface World {
  items: CollateralView[];
  borrowers: BorrowerView[];
  /** Оролцогчдын жагсаалтын `summary.editable` (DRAFT/RETURNED). */
  editable: boolean;
  loanAmount: number | null;
  requiresCollateral: boolean;
  ltvLimit: number;
  /** `POST …/valuation/suggest`-ийн хариу. */
  suggestion: SuggestValuationResponse;
  history: CollateralValuationRecord[];
  /** ХУР-аас татах хөрөнгө. */
  xypAssets: CollateralCandidate[];
  /** true бол `POST …/registry` нь 409 (хүсэлт батлагдаагүй). */
  registryBlocked: boolean;
  /** dms-д байршуулсан файлууд (нэр → id). */
  uploads: Array<{ id: string; name: string }>;
  seq: number;
}

export const VEHICLE_SUGGESTION: SuggestValuationResponse = {
  assetType: 'VEHICLE',
  suggestion: {
    available: true,
    method: 'VEHICLE_BASE_PRICE',
    marketValue: 20_000_000,
    lowValue: 18_000_000,
    highValue: 22_000_000,
    confidence: 'MEDIUM',
    basis: {},
    // DEMO: суурь үнэ, элэгдлийн коэффициент батлагдаагүй туршилтын утга
    warnings: ['DEMO_PARAMETERS', 'MILEAGE_NOT_PROVIDED'],
    unavailableReason: null,
  },
  haircut: { rate: 0.7, source: 'DEMO_DEFAULT' },
  manualValueRequired: false,
  externalValuationThreshold: 100_000_000,
};

export function newWorld(overrides: Partial<World> = {}): World {
  return {
    items: [],
    borrowers: [makeBorrower(), makeBorrower({ id: 'b-guarantor', customerId: IDS.guarantor, role: 'GUARANTOR', isPrimary: false, name: 'Дорж Батаа' })],
    editable: true,
    loanAmount: 10_000_000,
    requiresCollateral: true,
    ltvLimit: 0.7,
    suggestion: VEHICLE_SUGGESTION,
    history: [],
    xypAssets: [],
    registryBlocked: false,
    uploads: [],
    seq: 0,
    ...overrides,
  };
}

const fileId = (n: number): string => `0a1b2c3d-4444-4a44-8a44-${String(100 + n).padStart(12, '0')}`;
export const collateralId = (n: number): string => `0a1b2c3d-3333-4a33-8a33-${String(100 + n).padStart(12, '0')}`;

// ── "сервер" талын тооцоолол ─────────────────────────────────────────────────────────────────
function itemIssues(c: CollateralView): GateIssue[] {
  const out: GateIssue[] = [];
  const add = (code: GateIssue['code'], message: string) => out.push({ code, collateralId: c.id, message });
  if (!c.ownership) add('OWNERSHIP_NOT_CHECKED', 'Өмчлөлийг шалгаагүй байна');
  else if (c.ownership.status === 'OWNER_MISMATCH') add('OWNER_MISMATCH', 'Бүртгэлийн өмчлөгч таарахгүй байна');
  else if (c.ownership.status === 'OWNER_NOT_ON_APPLICATION') add('OWNER_NOT_ON_APPLICATION', 'Өмчлөгч хүсэлтийн оролцогч биш');
  if (!c.encumbrance) add('ENCUMBRANCE_NOT_CHECKED', 'Ачааллыг шалгаагүй байна');
  else if (c.encumbrance.status === 'ENCUMBERED') add('ENCUMBERED', 'Хөрөнгө ачаалалтай байна');
  else if (c.encumbrance.status === 'DISPUTED') add('ENCUMBRANCE_DISPUTED', 'Хөрөнгө маргаантай байна');
  if (c.checklist.some((r) => r.required && !r.satisfied)) add('CHECKLIST_INCOMPLETE', 'Заавал баримт дутуу байна');
  if (!c.valuation) add('NOT_VALUED', 'Үнэлгээ хийгдээгүй байна');
  else if (c.valuation.expired) add('VALUATION_EXPIRED', 'Үнэлгээний хугацаа дууссан');
  else if (c.valuation.externalRequired && !c.valuation.externalSatisfied) add('EXTERNAL_VALUATION_REQUIRED', 'Гадны лицензтэй үнэлгээ шаардлагатай');
  return out;
}

export function snapshot(w: World) {
  w.items = w.items.map((c) => ({ ...c, issues: itemIssues(c) }));
  const totalMarketValue = w.items.reduce((s, c) => s + (c.valuation?.marketValue ?? 0), 0);
  const totalCollateralValue = w.items.reduce((s, c) => s + (c.valuation?.collateralValue ?? 0), 0);
  const ltv = w.loanAmount !== null && totalCollateralValue > 0 ? w.loanAmount / totalCollateralValue : null;
  const ltvPass = ltv === null ? null : ltv <= w.ltvLimit;
  const summary = makeSummary({ count: w.items.length, totalMarketValue, totalCollateralValue, loanAmount: w.loanAmount, ltv, ltvLimit: w.ltvLimit, ltvPass, requiresCollateral: w.requiresCollateral });
  const issues: GateIssue[] = [];
  if (w.loanAmount === null) issues.push({ code: 'LOAN_AMOUNT_MISSING', collateralId: null, message: 'Зээлийн дүн оруулаагүй тул LTV тооцох боломжгүй' });
  if (w.requiresCollateral && w.items.length === 0) issues.push({ code: 'NO_COLLATERAL', collateralId: null, message: 'Барьцаа бүртгээгүй байна' });
  for (const c of w.items) issues.push(...c.issues);
  if (ltvPass === false) issues.push({ code: 'LTV_EXCEEDED', collateralId: null, message: `LTV ${(ltv! * 100).toFixed(1)}% нь дээд хязгаар ${(w.ltvLimit * 100).toFixed(0)}%-иас хэтэрсэн` });
  const skipped = !w.requiresCollateral && w.items.length === 0;
  const gate = { complete: issues.length === 0 && !skipped, skipped, issues, evaluatedAt: NOW };
  const warnings = w.items.filter((c) => c.insuranceExpiresAt).map((c) => ({ code: 'INSURANCE_EXPIRING' as const, collateralId: c.id, message: 'Даатгал удахгүй дуусна' }));
  return { summary, gate, warnings };
}

const mutation = (w: World, id: string): CollateralMutationResponse => {
  const snap = snapshot(w);
  const collateral = w.items.find((c) => c.id === id)!;
  return makeMutation(collateral, snap);
};

const fail = (status: number, code: string, message: string, details?: unknown): MockReply => ({ status, json: { code, message, ...(details ? { details } : {}) } });
const validation = (error: { issues: Array<{ path: Array<string | number>; message: string }> }): MockReply =>
  fail(422, 'VALIDATION_FAILED', 'Оруулсан мэдээлэл буруу', error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));

const CHECKLISTS: Record<string, Array<{ key: string; label: string; required?: boolean }>> = {
  VEHICLE: [{ key: 'vehicle_certificate', label: 'Тээврийн хэрэгслийн гэрчилгээ' }, { key: 'insurance', label: 'Даатгалын гэрээ', required: false }],
  APARTMENT: [{ key: 'ownership_certificate', label: 'Өмчлөх эрхийн гэрчилгээ' }, { key: 'cadastral_plan', label: 'Кадастрын зураг', required: false }],
  INVENTORY: [{ key: 'stocktake_act', label: 'Тооллогын акт' }],
};

const withItem = (w: World, id: string, patch: (c: CollateralView) => CollateralView): CollateralView | null => {
  const found = w.items.find((c) => c.id === id);
  if (!found) return null;
  const next = patch(found);
  w.items = w.items.map((c) => (c.id === id ? next : c));
  return next;
};

/** Барьцааны алхмын бүх дуудлагыг `api`-д бүртгэнэ. */
export function installCollateralApi(api: MockApi, w: World): World {
  const notFound = fail(404, 'COLLATERAL_NOT_FOUND', 'Барьцаа олдсонгүй');
  const notEditable = fail(409, 'APPLICATION_NOT_EDITABLE', 'Хүсэлт «Шинэ» эсвэл «Буцаасан» төлөвт байх үед л өөрчилнө');

  api.get('/applications/:aid/borrowers', () => ({ json: makeBorrowerList(w.borrowers, w.editable) }));
  api.get('/applications/:aid/collaterals', () => ({ json: makeList(w.items, snapshot(w)) }));
  api.post('/applications/:aid/collaterals/recheck', () => ({ json: makeList(w.items, snapshot(w)) }));
  api.get('/applications/:aid/collaterals/xyp-assets', () => ({ json: { items: w.xypAssets, fetchedAt: NOW } }));

  api.post('/applications/:aid/collaterals', ({ body }) => {
    if (!w.editable) return notEditable;
    const parsed = CreateCollateralRequest.safeParse(body);
    if (!parsed.success) return validation(parsed.error);
    const owner = w.borrowers.find((b) => b.customerId === parsed.data.ownerCustomerId);
    if (!owner) return fail(422, 'OWNER_NOT_ON_APPLICATION', 'Өмчлөгч хүсэлтийн оролцогч биш байна');
    const d = parsed.data;
    const id = collateralId(++w.seq);
    const created = makeCollateral({
      id,
      kind: collateralKindOf(d.assetType),
      assetType: d.assetType,
      description: d.description as Record<string, unknown>,
      source: d.source,
      owner: { customerId: owner.customerId, displayName: owner.customer.displayName, role: owner.role },
      registryNo: d.registryNo ?? null,
      registryDate: d.registryDate ?? null,
      insuranceExpiresAt: d.insuranceExpiresAt ?? null,
      note: d.note ?? null,
      checklist: makeChecklist(CHECKLISTS[d.assetType] ?? []),
    });
    w.items = [...w.items, created];
    return { status: 201, json: mutation(w, id) };
  });

  api.patch('/applications/:aid/collaterals/:cid', ({ params }) => {
    if (!w.editable) return notEditable;
    return w.items.some((c) => c.id === params.cid) ? { json: mutation(w, params.cid!) } : notFound;
  });

  api.on('DELETE', '/applications/:aid/collaterals/:cid', ({ params }) => {
    if (!w.editable) return notEditable;
    if (!w.items.some((c) => c.id === params.cid)) return notFound;
    w.items = w.items.filter((c) => c.id !== params.cid);
    return { status: 204 };
  });

  api.post('/applications/:aid/collaterals/:cid/ownership-check', ({ params, body }) => {
    if (!w.editable) return notEditable;
    const parsed = OwnershipCheckRequest.safeParse(body);
    if (!parsed.success) return validation(parsed.error);
    const owner = w.borrowers.find((b) => b.customerId === w.items.find((c) => c.id === params.cid)?.owner.customerId);
    const item = withItem(w, params.cid!, (c) => ({
      ...c,
      ownership: makeOwnership({
        method: parsed.data.method,
        source: parsed.data.method === 'DECLARED' ? 'DECLARED' : 'XYP',
        note: parsed.data.note ?? null,
        owners: [{ registerMasked: 'УБ****5678', name: owner?.customer.displayName ?? '', matchedCustomerId: owner?.customerId ?? null, role: owner?.role ?? null }],
      }),
    }));
    return item ? { json: mutation(w, params.cid!) } : notFound;
  });

  api.post('/applications/:aid/collaterals/:cid/encumbrance-check', ({ params, body }) => {
    if (!w.editable) return notEditable;
    const parsed = RunEncumbranceCheckRequest.safeParse(body);
    if (!parsed.success) return validation(parsed.error);
    const item = withItem(w, params.cid!, (c) => ({
      ...c,
      encumbrance: makeEncumbrance(
        c.description.plateNo === '9999УБА'
          ? { status: 'ENCUMBERED', sources: [{ source: 'ZMS', status: 'ENCUMBERED', pledgee: 'Жишиг банк', registeredAt: '2025-06-01', note: null }, { source: 'EB', status: 'CLEAR', pledgee: null, registeredAt: null, note: null }] }
          : { method: parsed.data.method, note: parsed.data.note ?? null },
      ),
    }));
    return item ? { json: mutation(w, params.cid!) } : notFound;
  });

  api.post('/applications/:aid/collaterals/:cid/valuation/suggest', () => ({ json: w.suggestion }));

  api.post('/applications/:aid/collaterals/:cid/valuation', ({ params, body }) => {
    const parsed = SaveValuationRequest.safeParse(body);
    if (!parsed.success) return validation(parsed.error);
    const suggested = w.suggestion.suggestion.available ? w.suggestion.suggestion.marketValue : null;
    const marketValue = parsed.data.marketValue ?? suggested;
    if (marketValue === null) return fail(422, 'MARKET_VALUE_REQUIRED', 'Системийн санал байхгүй тул зах зээлийн үнийг оруулна уу');
    if (parsed.data.marketValue !== undefined && parsed.data.marketValue !== suggested && !parsed.data.overrideReason) {
      return fail(422, 'OVERRIDE_REASON_REQUIRED', 'Системийн саналаас өөр дүн оруулсан тул шалтгаан заавал');
    }
    // "Сервер" тооцно: дүнг 100,000₮-д доош бөөрөнхийлнө — UI өөрөө marketValue × haircut-аар тооцвол энд зөрнө.
    const collateralValue = Math.floor((marketValue * w.suggestion.haircut.rate) / 100_000) * 100_000;
    const valuation = makeValuation({ marketValue, haircutRate: w.suggestion.haircut.rate, collateralValue, overrideReason: parsed.data.overrideReason ?? null });
    const item = withItem(w, params.cid!, (c) => ({ ...c, valuation }));
    if (!item) return notFound;
    w.history = [
      {
        id: `h${w.history.length + 1}`, collateralId: params.cid!, source: 'INTERNAL', method: w.suggestion.suggestion.method ?? 'MANUAL', appraiser: null, licenseNo: null, valuedAt: NOW, validUntil: valuation.validUntil,
        marketValue, suggestedValue: suggested, haircutRate: valuation.haircutRate, haircutSource: w.suggestion.haircut.source, collateralValue, overrideReason: valuation.overrideReason, reportFileId: null, externalRequired: false, createdBy: 'officer.a',
      },
      ...w.history,
    ];
    return { json: mutation(w, params.cid!) };
  });

  api.post('/applications/:aid/collaterals/:cid/valuation/external', ({ params, body }) => {
    const parsed = ExternalValuationRequest.safeParse(body);
    if (!parsed.success) return validation(parsed.error);
    const collateralValue = Math.floor((parsed.data.marketValue * w.suggestion.haircut.rate) / 100_000) * 100_000;
    const item = withItem(w, params.cid!, (c) => ({ ...c, valuation: makeValuation({ source: 'EXTERNAL_LICENSED', marketValue: parsed.data.marketValue, collateralValue, haircutRate: w.suggestion.haircut.rate, externalRequired: true, externalSatisfied: true }) }));
    return item ? { json: mutation(w, params.cid!) } : notFound;
  });

  api.get('/applications/:aid/collaterals/:cid/valuations', ({ params }) => ({ json: { items: w.history.filter((h) => h.collateralId === params.cid) } }));

  api.post('/applications/:aid/collaterals/:cid/documents', ({ params, body }) => {
    if (!w.editable) return notEditable;
    const parsed = AttachCollateralDocumentRequest.safeParse(body);
    if (!parsed.success) return validation(parsed.error);
    const upload = w.uploads.find((u) => u.id === parsed.data.fileId);
    const doc: CollateralDocumentView = { id: `doc-${++w.seq}`, checklistKey: parsed.data.checklistKey, fileId: parsed.data.fileId, fileName: upload?.name ?? 'file', mime: 'application/pdf', size: 2048, note: null, uploadedBy: 'officer.a', uploadedAt: NOW };
    const item = withItem(w, params.cid!, (c) => {
      const onRow = c.checklist.some((r) => r.key === doc.checklistKey);
      return {
        ...c,
        checklist: c.checklist.map((r) => (r.key === doc.checklistKey ? { ...r, documents: [...r.documents, doc], satisfied: true } : r)),
        extraDocuments: onRow ? c.extraDocuments : [...c.extraDocuments, doc],
      };
    });
    return item ? { json: mutation(w, params.cid!) } : notFound;
  });

  api.on('DELETE', '/applications/:aid/collaterals/:cid/documents/:docId', ({ params }) => {
    const item = withItem(w, params.cid!, (c) => ({
      ...c,
      checklist: c.checklist.map((r) => {
        const documents = r.documents.filter((d) => d.id !== params.docId);
        return { ...r, documents, satisfied: documents.length > 0 };
      }),
      extraDocuments: c.extraDocuments.filter((d) => d.id !== params.docId),
    }));
    return item ? { json: mutation(w, params.cid!) } : notFound;
  });

  api.post('/applications/:aid/collaterals/:cid/registry', ({ params, body }) => {
    const parsed = RegisterPledgeRequest.safeParse(body);
    if (!parsed.success) return validation(parsed.error);
    if (w.registryBlocked) return fail(409, 'APPLICATION_NOT_APPROVED', 'Хүсэлт батлагдаагүй тул барьцааг ЭБ-д бүртгэх боломжгүй');
    const item = withItem(w, params.cid!, (c) => ({ ...c, registryNo: parsed.data.registryNo, registryDate: parsed.data.registryDate }));
    return item ? { json: mutation(w, params.cid!) } : notFound;
  });

  api.post('/applications/:aid/collaterals/:cid/release', ({ params }) => {
    if (w.registryBlocked) return fail(409, 'APPLICATION_NOT_CLOSED', 'Зээл хаагдаагүй тул барьцааг чөлөөлөх боломжгүй');
    const item = withItem(w, params.cid!, (c) => ({ ...c, releasedAt: NOW }));
    return item ? { json: mutation(w, params.cid!) } : notFound;
  });

  installDms(api, w.uploads, () => ++w.seq);
  return w;
}

/** dms файл сан: байршуулалт (multipart) ба татаалт. */
export function installDms(api: MockApi, uploads: Array<{ id: string; name: string }>, next: () => number): void {
  api.post('/dms/files', (req: MockRequest) => {
    const raw = typeof req.body === 'string' ? req.body : '';
    const name = /filename="([^"]+)"/.exec(raw)?.[1] ?? 'upload.bin';
    const id = fileId(next());
    uploads.push({ id, name });
    return { status: 201, json: { id, name, mime: name.endsWith('.png') ? 'image/png' : 'application/pdf', size: 2048 } };
  });
  api.get('/dms/files/:id/content', () => ({ json: { content: 'DEMO: файлын агуулга' } }));
}

