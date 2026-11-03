import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InquiryFetchBody, UnregisteredLoanInput } from '@los/contracts';
import * as api from './inquiry.api';

export const inquiryKey = (applicationId: string) => ['inquiry', applicationId] as const;

export const useInquiries = (applicationId: string) =>
  useQuery({ queryKey: inquiryKey(applicationId), queryFn: () => api.fetchInquiries(applicationId), retry: false });

/** Мутаци бүрийн дараа жагсаалтыг шинэчилж, `onChanged` (wizard-ийн алхмын төлөв) дуудна. */
function useInquiryMutation<TVars, TData>(applicationId: string, fn: (v: TVars) => Promise<TData>, onChanged?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: inquiryKey(applicationId) });
      onChanged?.();
    },
  });
}

export const useFetchInquiries = (applicationId: string, onChanged?: () => void) =>
  useInquiryMutation(applicationId, (body: InquiryFetchBody) => api.fetchInquiriesNow(applicationId, body), onChanged);
export const useRecheckInquiries = (applicationId: string, onChanged?: () => void) =>
  useInquiryMutation(applicationId, () => api.recheckInquiries(applicationId), onChanged);
export const useAddLoan = (applicationId: string, onChanged?: () => void) =>
  useInquiryMutation(applicationId, (v: UnregisteredLoanInput & { customerId: string }) => api.addUnregisteredLoan(applicationId, v), onChanged);
export const useRemoveLoan = (applicationId: string, onChanged?: () => void) =>
  useInquiryMutation(applicationId, (loanId: string) => api.removeUnregisteredLoan(applicationId, loanId), onChanged);
