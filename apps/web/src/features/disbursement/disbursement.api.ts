import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DisbursementView, type UpdateDisbursementRequest } from '@los/contracts';
import { originationFetch } from '../../lib/api';

// FR-12: `/applications/:id/disbursement` (GET · PUT · submit · approve · reject).
const base = (id: string): string => `/applications/${encodeURIComponent(id)}/disbursement`;
export const disbursementKey = (id: string) => ['disbursement', id] as const;

export const useDisbursement = (id: string) => useQuery({ queryKey: disbursementKey(id), queryFn: () => originationFetch(base(id), { schema: DisbursementView }), retry: false });

function useDisbMutation<V>(id: string, fn: (v: V) => Promise<DisbursementView>, onChanged?: () => void) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (res) => { qc.setQueryData(disbursementKey(id), res); onChanged?.(); } });
}
export const useUpdateDisbursement = (id: string, onChanged?: () => void) => useDisbMutation(id, (b: UpdateDisbursementRequest) => originationFetch(base(id), { method: 'PUT', json: b, schema: DisbursementView }), onChanged);
export const useSubmitDisbursement = (id: string, onChanged?: () => void) => useDisbMutation(id, () => originationFetch(`${base(id)}/submit`, { method: 'POST', schema: DisbursementView }), onChanged);
export const useApproveDisbursement = (id: string, onChanged?: () => void) => useDisbMutation(id, (comment?: string) => originationFetch(`${base(id)}/approve`, { method: 'POST', json: { comment }, schema: DisbursementView }), onChanged);
export const useRejectDisbursement = (id: string, onChanged?: () => void) => useDisbMutation(id, (comment?: string) => originationFetch(`${base(id)}/reject`, { method: 'POST', json: { comment }, schema: DisbursementView }), onChanged);
