import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { CreateApplicationRequest, TransitionRequest, VoteRequest } from '@los/contracts';
import { decisionKey, voteApplication } from '../decision/decision.api';
import * as api from './applications.api';

export const applicationsKey = ['applications'] as const;
/** `applicationsKey`-ийн дор: нэг `invalidateQueries(applicationsKey)` жагсаалт, тоолуур, "Миний батлах"-ыг хамтад нь шинэчилнэ. */
export const myApprovalsKey = [...applicationsKey, 'mine'] as const;
export const directoryKey = ['directory'] as const;
export const applicationListKey = (params: api.ListParams) => [...applicationsKey, 'list', params] as const;
export const applicationDetailKey = (id: string) => [...applicationsKey, 'detail', id] as const;

const retryTransient = (failureCount: number, error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return failureCount < 1 && !(typeof status === 'number' && status < 500);
};

export const useApplicationList = (params: api.ListParams) =>
  useQuery({ queryKey: applicationListKey(params), queryFn: () => api.fetchApplications(params), placeholderData: keepPreviousData, retry: retryTransient });

export const useApplication = (id: string) =>
  useQuery({ queryKey: applicationDetailKey(id), queryFn: () => api.fetchApplication(id), retry: retryTransient, refetchOnMount: 'always' });

export function useCreateApplication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: CreateApplicationRequest; idempotencyKey?: string }) => api.createApplication(body, idempotencyKey),
    onSuccess: () => qc.invalidateQueries({ queryKey: applicationsKey }),
  });
}

export function useTransition(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: TransitionRequest) => api.transitionApplication(id, body), onSettled: () => qc.invalidateQueries({ queryKey: applicationsKey }) });
}

/** FR-1.1 "Миний батлах" таб: `enabled` нь зөвхөн тухайн таб нээлттэй үед ачаална (тоолуур нь жагсаалтын хариунд аль хэдийн байна). */
export const useMyApprovals = (enabled: boolean) =>
  useQuery({ queryKey: myApprovalsKey, queryFn: api.fetchMyApprovals, enabled, retry: retryTransient });

/** FR-1.2: салбар/ЗЭЗ-ийн id → нэр. Ховор өөрчлөгддөг тул 5 минут cache. */
export const useDirectory = () =>
  useQuery({ queryKey: directoryKey, queryFn: api.fetchDirectory, staleTime: 5 * 60_000, retry: retryTransient });

/** Санал өгсний дараа: жагсаалт + тоолуур (myApprovalCount) + "Миний батлах" + тухайн хүсэлтийн шийдвэр. Лавлахыг шинэчлэхгүй. */
export function invalidateAfterVote(qc: QueryClient, applicationId: string): Promise<unknown> {
  return Promise.all([qc.invalidateQueries({ queryKey: applicationsKey }), qc.invalidateQueries({ queryKey: decisionKey(applicationId) })]);
}

/**
 * FR-1.5: жагсаалтын мөрөөс санал өгөх (байгаа санал өгөх API). `onSettled` — алдаа (ALREADY_VOTED, NOT_IN_APPROVAL: өөр хүн/цонхонд аль хэдийн
 * шийдсэн) гарсан ч жагсаалтыг шинэчилж хоцрогдсон мөрийг арилгана. Шинэчлэлт дуустал хүлээнэ → `mutateAsync` буцахад жагсаалт шинэ.
 */
export function useListVote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ applicationId, body }: { applicationId: string; body: VoteRequest }) => voteApplication(applicationId, body),
    onSettled: (_data, _error, { applicationId }) => invalidateAfterVote(qc, applicationId),
  });
}

/** Алхмын бүрдэл өөрчлөгдсөний дараа wizard-ийн зүүн самбарыг шинэчлэх. */
export function useRefreshApplication(id: string) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: applicationDetailKey(id) });
}
