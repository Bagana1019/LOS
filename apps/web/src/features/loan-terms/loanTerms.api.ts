import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CibPurposesResponse, LoanProductsResponse, LoanTermsView, type SaveLoanTermsRequest } from '@los/contracts';
import { originationFetch } from '../../lib/api';

// FR-5: gateway → origination `/loan-terms/*`, `/applications/:id/loan-terms`.
const base = (id: string): string => `/applications/${encodeURIComponent(id)}/loan-terms`;
export const termsKey = (id: string) => ['loan-terms', id] as const;

export const useLoanTerms = (id: string) => useQuery({ queryKey: termsKey(id), queryFn: () => originationFetch(base(id), { schema: LoanTermsView }), retry: false });
export const useProducts = () => useQuery({ queryKey: ['loan-terms', 'products'], queryFn: () => originationFetch('/loan-terms/products', { schema: LoanProductsResponse }), staleTime: 60_000 });
export const useCibPurposes = () => useQuery({ queryKey: ['loan-terms', 'cib'], queryFn: () => originationFetch('/loan-terms/cib-purposes', { schema: CibPurposesResponse }), staleTime: 300_000 });

export function useSaveTerms(id: string, onChanged?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveLoanTermsRequest) => originationFetch(base(id), { method: 'PUT', json: body, schema: LoanTermsView }),
    onSuccess: (res) => {
      qc.setQueryData(termsKey(id), res);
      void qc.invalidateQueries({ queryKey: ['schedule', id] });
      onChanged?.();
    },
  });
}
