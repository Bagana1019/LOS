import {
  CollateralCandidatesResponse, CollateralListResponse, CollateralMonitoringResponse, CollateralMutationResponse, SuggestValuationResponse, ValuationHistoryResponse,
  type AttachCollateralDocumentRequest, type CreateCollateralRequest, type ExternalValuationRequest, type OwnershipCheckRequest, type RegisterPledgeRequest,
  type RunEncumbranceCheckRequest, type SaveValuationRequest, type UpdateCollateralRequest,
} from '@los/contracts';
import { originationFetch, qs } from '../../lib/api';

// Gateway-ийн замаар origination руу (`originationFetch` нь `/origination` угтварыг нэмнэ → `/api/origination/…`). Замууд: docs/05 §3.1.
// Хариуг `@los/contracts`-ийн zod схемээр шалгана — гэрээ зөрвөл ойлгомжтой алдаа.
const base = (applicationId: string): string => `/applications/${encodeURIComponent(applicationId)}/collaterals`;
const one = (applicationId: string, collateralId: string): string => `${base(applicationId)}/${encodeURIComponent(collateralId)}`;

export const fetchCollaterals = (applicationId: string): Promise<CollateralListResponse> =>
  originationFetch(base(applicationId), { schema: CollateralListResponse });

export const createCollateral = (applicationId: string, body: CreateCollateralRequest): Promise<CollateralMutationResponse> =>
  originationFetch(base(applicationId), { method: 'POST', json: body, schema: CollateralMutationResponse });

export const updateCollateral = (applicationId: string, collateralId: string, body: UpdateCollateralRequest): Promise<CollateralMutationResponse> =>
  originationFetch(one(applicationId, collateralId), { method: 'PATCH', json: body, schema: CollateralMutationResponse });

/** 204 No Content. */
export const removeCollateral = (applicationId: string, collateralId: string): Promise<void> =>
  originationFetch<void>(one(applicationId, collateralId), { method: 'DELETE' });

/** Модуль 5 зээлийн дүн өөрчлөгдсөний дараа G0-г дахин тооцож 5-р алхмыг шинэчилнэ. */
export const recheckCollaterals = (applicationId: string): Promise<CollateralListResponse> =>
  originationFetch(`${base(applicationId)}/recheck`, { method: 'POST', schema: CollateralListResponse });

/** ХУР-ын хөрөнгө (FR-6.3). */
export const fetchXypAssets = (applicationId: string, ownerCustomerId: string): Promise<CollateralCandidatesResponse> =>
  originationFetch(`${base(applicationId)}/xyp-assets${qs({ ownerCustomerId })}`, { schema: CollateralCandidatesResponse });

export const checkOwnership = (applicationId: string, collateralId: string, body: OwnershipCheckRequest): Promise<CollateralMutationResponse> =>
  originationFetch(`${one(applicationId, collateralId)}/ownership-check`, { method: 'POST', json: body, schema: CollateralMutationResponse });

export const checkEncumbrance = (applicationId: string, collateralId: string, body: RunEncumbranceCheckRequest): Promise<CollateralMutationResponse> =>
  originationFetch(`${one(applicationId, collateralId)}/encumbrance-check`, { method: 'POST', json: body, schema: CollateralMutationResponse });

/** Системийн санал (хадгалахгүй). Body-д зөвхөн гүйлт. */
export const suggestValuation = (applicationId: string, collateralId: string, body: Pick<SaveValuationRequest, 'mileageKm'>): Promise<SuggestValuationResponse> =>
  originationFetch(`${one(applicationId, collateralId)}/valuation/suggest`, { method: 'POST', json: body, schema: SuggestValuationResponse });

export const saveValuation = (applicationId: string, collateralId: string, body: SaveValuationRequest): Promise<CollateralMutationResponse> =>
  originationFetch(`${one(applicationId, collateralId)}/valuation`, { method: 'POST', json: body, schema: CollateralMutationResponse });

export const recordExternalValuation = (applicationId: string, collateralId: string, body: ExternalValuationRequest): Promise<CollateralMutationResponse> =>
  originationFetch(`${one(applicationId, collateralId)}/valuation/external`, { method: 'POST', json: body, schema: CollateralMutationResponse });

export const fetchValuationHistory = (applicationId: string, collateralId: string): Promise<ValuationHistoryResponse> =>
  originationFetch(`${one(applicationId, collateralId)}/valuations`, { schema: ValuationHistoryResponse });

export const attachCollateralDocument = (applicationId: string, collateralId: string, body: AttachCollateralDocumentRequest): Promise<CollateralMutationResponse> =>
  originationFetch(`${one(applicationId, collateralId)}/documents`, { method: 'POST', json: body, schema: CollateralMutationResponse });

export const detachCollateralDocument = (applicationId: string, collateralId: string, documentId: string): Promise<CollateralMutationResponse> =>
  originationFetch(`${one(applicationId, collateralId)}/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE', schema: CollateralMutationResponse });

/** ЭБ бүртгэл (FR-6.9). Хүсэлтийн төлөв тохирохгүй бол 409 (монгол мессежтэй). */
export const registerPledge = (applicationId: string, collateralId: string, body: RegisterPledgeRequest): Promise<CollateralMutationResponse> =>
  originationFetch(`${one(applicationId, collateralId)}/registry`, { method: 'POST', json: body, schema: CollateralMutationResponse });

export const releaseCollateral = (applicationId: string, collateralId: string): Promise<CollateralMutationResponse> =>
  originationFetch(`${one(applicationId, collateralId)}/release`, { method: 'POST', schema: CollateralMutationResponse });

/** Хугацаа дуусах / дахин үнэлэх / LTV хэтэрсэн (FR-6.9, FR-14.6). Хүсэлтээс үл хамаарна. */
export const fetchCollateralMonitoring = (withinDays: number): Promise<CollateralMonitoringResponse> =>
  originationFetch(`/collaterals/monitoring${qs({ withinDays })}`, { schema: CollateralMonitoringResponse });
