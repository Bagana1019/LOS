import type {
  AddBorrowerRequest,
  BorrowerCandidate,
  BorrowerListResponse,
  BorrowerMutationResponse,
  RecordConsentRequest,
  UpdateBorrowerRequest,
} from '@los/contracts';
import { apiFetch, qs } from '../../lib/api';

// Gateway-н замаар origination руу: `/applications/:applicationId/borrowers…` (global prefix `api` нь API суурь URL-д орсон).
const base = (applicationId: string): string => `/applications/${encodeURIComponent(applicationId)}/borrowers`;
const one = (applicationId: string, borrowerId: string): string => `${base(applicationId)}/${encodeURIComponent(borrowerId)}`;

export const fetchBorrowers = (applicationId: string): Promise<BorrowerListResponse> => apiFetch<BorrowerListResponse>(base(applicationId));

/** Регистрээр (blind index) байгаа харилцагч хайх. Олдохгүй бол []. */
export const fetchCandidates = (applicationId: string, registerNo: string): Promise<BorrowerCandidate[]> =>
  apiFetch<BorrowerCandidate[]>(`${base(applicationId)}/candidates${qs({ registerNo })}`);

export const addBorrower = (applicationId: string, body: AddBorrowerRequest): Promise<BorrowerMutationResponse> =>
  apiFetch<BorrowerMutationResponse>(base(applicationId), { method: 'POST', json: body });

export const updateBorrower = (applicationId: string, borrowerId: string, body: UpdateBorrowerRequest): Promise<BorrowerMutationResponse> =>
  apiFetch<BorrowerMutationResponse>(one(applicationId, borrowerId), { method: 'PATCH', json: body });

/** 204 No Content. */
export const removeBorrower = (applicationId: string, borrowerId: string): Promise<void> =>
  apiFetch<void>(one(applicationId, borrowerId), { method: 'DELETE' });

export const makePrimary = (applicationId: string, borrowerId: string): Promise<BorrowerMutationResponse> =>
  apiFetch<BorrowerMutationResponse>(`${one(applicationId, borrowerId)}/make-primary`, { method: 'POST' });

export const recordConsent = (applicationId: string, borrowerId: string, body: RecordConsentRequest): Promise<BorrowerMutationResponse> =>
  apiFetch<BorrowerMutationResponse>(`${one(applicationId, borrowerId)}/consent`, { method: 'POST', json: body });
