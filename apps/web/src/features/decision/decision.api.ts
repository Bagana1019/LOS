import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DecisionView, type VoteRequest } from '@los/contracts';
import { ApiError, originationFetch } from '../../lib/api';

// FR-10: `/applications/:id/decision`, `/applications/:id/approval/vote`.
export const decisionKey = (id: string) => ['decision', id] as const;
export const useDecision = (id: string) => useQuery({ queryKey: decisionKey(id), queryFn: () => originationFetch(`/applications/${encodeURIComponent(id)}/decision`, { schema: DecisionView }), retry: false });
/** Нэг санал өгөх дуудлага (Шийдвэр алхам + хүсэлтийн жагсаалтын "Миний батлах" мөр хоёулаа). Дүрмийг (Буцаахад тайлбар, өөрийн хүсэлт, түвшний гишүүн) сервер шалгана. */
export const voteApplication = (id: string, body: VoteRequest) => originationFetch(`/applications/${encodeURIComponent(id)}/approval/vote`, { method: 'POST', json: body });
/** FR-1.5: хуудсанд харагдаж буй идэвхтэй түвшин, хувилбар — санал өгөхдөө дамжуулна. Сервер зөрвөл 409 VOTE_TARGET_CHANGED. Идэвхтэй түвшин байхгүй бол зөвхөн version. */
export const voteTargetOf = (d: Pick<DecisionView, 'version' | 'approval'>): { levelNo?: number; version: number } =>
  ({ version: d.version, ...(d.approval.currentLevel != null ? { levelNo: d.approval.currentLevel } : {}) });
export function useVote(id: string, onChanged?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: VoteRequest) => voteApplication(id, body),
    // 409 (VOTE_TARGET_CHANGED, NOT_IN_APPROVAL, ALREADY_VOTED): харж буй төлөв хоцорсон — шийдвэрийн хуудас, wizard-ийг шинэчилнэ.
    onError: (e) => { if (e instanceof ApiError && e.status === 409) { void qc.invalidateQueries({ queryKey: decisionKey(id) }); onChanged?.(); } },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: decisionKey(id) }); onChanged?.(); },
  });
}
