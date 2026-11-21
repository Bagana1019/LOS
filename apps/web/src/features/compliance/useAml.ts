import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AmlHitReviewRequest } from '@los/contracts';
import { ApiError } from '../../lib/api';
import * as api from './aml.api';

export const amlKey = ['aml'] as const;

export const useAmlQueue = (p: api.AmlQueueParams) =>
  useQuery({ queryKey: [...amlKey, 'queue', p], queryFn: () => api.fetchAmlQueue(p), placeholderData: keepPreviousData });

export const useAmlScreening = (id: string) =>
  useQuery({ queryKey: [...amlKey, 'screening', id], queryFn: () => api.fetchAmlScreening(id), enabled: id.length > 0 });

/** Шийдвэрийн дараа дараалал ба дэлгэрэнгүйг дахин ачаална (төлөв kyc-д бодогдоно, UI тооцоолохгүй). */
export function useReviewAmlHit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { hitId: string; body: AmlHitReviewRequest }) => api.reviewAmlHit(v.hitId, v.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: amlKey }),
    // 409 (аль хэдийн шийдвэрлэсэн / шалгалт хуучирсан): ачаалсан өгөгдөл хуучирсан тул дахин ачаалж, бүртгэгдсэн шийдвэрийг харуулна.
    onError: (e) => (e instanceof ApiError && e.status === 409 ? qc.invalidateQueries({ queryKey: amlKey }) : undefined),
  });
}
