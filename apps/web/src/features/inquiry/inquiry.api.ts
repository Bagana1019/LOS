import { InquiriesResponse, type InquiryFetchBody, type UnregisteredLoan, type UnregisteredLoanInput } from '@los/contracts';
import { originationFetch } from '../../lib/api';

// Gateway-н замаар origination руу (`/origination` угтвар нэмэгдэнэ); origination-ий зам: `/applications/:applicationId/inquiries…`.
const base = (applicationId: string): string => `/applications/${encodeURIComponent(applicationId)}/inquiries`;

export const fetchInquiries = (applicationId: string): Promise<InquiriesResponse> => originationFetch(base(applicationId), { schema: InquiriesResponse });
export const fetchInquiriesNow = (applicationId: string, body: InquiryFetchBody): Promise<InquiriesResponse> =>
  originationFetch(`${base(applicationId)}/fetch`, { method: 'POST', json: body, schema: InquiriesResponse });
export const recheckInquiries = (applicationId: string): Promise<InquiriesResponse> =>
  originationFetch(`${base(applicationId)}/recheck`, { method: 'POST', schema: InquiriesResponse });
export const addUnregisteredLoan = (applicationId: string, body: UnregisteredLoanInput & { customerId: string }): Promise<UnregisteredLoan> =>
  originationFetch<UnregisteredLoan>(`${base(applicationId)}/unregistered-loans`, { method: 'POST', json: body });
/** 204 No Content. */
export const removeUnregisteredLoan = (applicationId: string, loanId: string): Promise<void> =>
  originationFetch<void>(`${base(applicationId)}/unregistered-loans/${encodeURIComponent(loanId)}`, { method: 'DELETE' });
