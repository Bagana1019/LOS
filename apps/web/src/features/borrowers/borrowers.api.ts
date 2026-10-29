import type {
  AddBorrowerRequest,
  BorrowerCandidate,
  BorrowerListResponse,
  BorrowerMutationResponse,
  RecordConsentRequest,
  UpdateBorrowerRequest,
} from '@los/contracts';
import { originationFetch, qs } from '../../lib/api';

// Gateway-н замаар origination руу (`originationFetch` нь `/origination` угтварыг нэмнэ → `/api/origination/…`); origination-ий зам: `/applications/:applicationId/borrowers…`.
const base = (applicationId: string): string => `/applications/${encodeURIComponent(applicationId)}/borrowers`;
const one = (applicationId: string, borrowerId: string): string => `${base(applicationId)}/${encodeURIComponent(borrowerId)}`;

export const fetchBorrowers = (applicationId: string): Promise<BorrowerListResponse> => originationFetch<BorrowerListResponse>(base(applicationId));

/** Регистрээр (blind index) байгаа харилцагч хайх. Олдохгүй бол []. */
export const fetchCandidates = (applicationId: string, registerNo: string): Promise<BorrowerCandidate[]> =>
  originationFetch<BorrowerCandidate[]>(`${base(applicationId)}/candidates${qs({ registerNo })}`);

export const addBorrower = (applicationId: string, body: AddBorrowerRequest): Promise<BorrowerMutationResponse> =>
  originationFetch<BorrowerMutationResponse>(base(applicationId), { method: 'POST', json: body });

export const updateBorrower = (applicationId: string, borrowerId: string, body: UpdateBorrowerRequest): Promise<BorrowerMutationResponse> =>
  originationFetch<BorrowerMutationResponse>(one(applicationId, borrowerId), { method: 'PATCH', json: body });

/** 204 No Content. */
export const removeBorrower = (applicationId: string, borrowerId: string): Promise<void> =>
  originationFetch<void>(one(applicationId, borrowerId), { method: 'DELETE' });

export const makePrimary = (applicationId: string, borrowerId: string): Promise<BorrowerMutationResponse> =>
  originationFetch<BorrowerMutationResponse>(`${one(applicationId, borrowerId)}/make-primary`, { method: 'POST' });

export const recordConsent = (applicationId: string, borrowerId: string, body: RecordConsentRequest): Promise<BorrowerMutationResponse> =>
  originationFetch<BorrowerMutationResponse>(`${one(applicationId, borrowerId)}/consent`, { method: 'POST', json: body });
