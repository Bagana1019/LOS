import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DecisionView, type VoteRequest } from '@los/contracts';
import { originationFetch } from '../../lib/api';

// FR-10: `/applications/:id/decision`, `/applications/:id/approval/vote`.
export const decisionKey = (id: string) => ['decision', id] as const;
export const useDecision = (id: string) => useQuery({ queryKey: decisionKey(id), queryFn: () => originationFetch(`/applications/${encodeURIComponent(id)}/decision`, { schema: DecisionView }), retry: false });
export function useVote(id: string, onChanged?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: VoteRequest) => originationFetch(`/applications/${encodeURIComponent(id)}/approval/vote`, { method: 'POST', json: body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: decisionKey(id) }); onChanged?.(); },
  });
}
