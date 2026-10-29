'use client';
// TanStack Query hooks. Mutations always invalidate list + summary + detail queries (also on error: a 409 means stale data).
import { useEffect, useState } from 'react';
import { App } from 'antd';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { mn } from '@los/ui';
import {
  approveRequest,
  cancelRequest,
  getRequest,
  getSummary,
  listPolicies,
  listRequests,
  rejectRequest,
  updatePolicy,
  type PolicyUpdate,
  type RequestsFilter,
} from './api';
import { ApiError, errorText } from './errors';

export const mcKeys = {
  all: ['maker-checker'] as const,
  list: (f: RequestsFilter) => ['maker-checker', 'list', f] as const,
  summary: ['maker-checker', 'summary'] as const,
  detail: (id: string | null) => ['maker-checker', 'detail', id] as const,
  policies: ['maker-checker', 'policies'] as const,
};

const invalidateAll = (qc: QueryClient) => qc.invalidateQueries({ queryKey: mcKeys.all });

/** Re-render on an interval so "time left" stays fresh. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export const useRequests = (filter: RequestsFilter) =>
  useQuery({
    queryKey: mcKeys.list(filter),
    queryFn: ({ signal }) => listRequests(filter, signal),
    placeholderData: keepPreviousData,
  });

export const useSummary = () =>
  useQuery({ queryKey: mcKeys.summary, queryFn: ({ signal }) => getSummary(signal), refetchInterval: 60_000 });

export const useRequest = (id: string | null) =>
  useQuery({ queryKey: mcKeys.detail(id), queryFn: ({ signal }) => getRequest(id as string, signal), enabled: id !== null });

export const usePolicies = () => useQuery({ queryKey: mcKeys.policies, queryFn: ({ signal }) => listPolicies(signal) });

export type DecisionKind = 'approve' | 'reject' | 'cancel';
export interface DecisionInput {
  id: string;
  comment?: string;
}

const decide = (kind: DecisionKind, { id, comment }: DecisionInput) =>
  kind === 'approve' ? approveRequest(id, comment) : kind === 'reject' ? rejectRequest(id, comment ?? '') : cancelRequest(id, comment);

/** approve / reject / cancel. Shows the server message on failure and refreshes everything either way. */
export function useDecision(kind: DecisionKind) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  return useMutation<unknown, ApiError | Error, DecisionInput>({
    mutationFn: (input) => decide(kind, input),
    onSuccess: () => message.success(mn[`maker_checker.toast.${kind}_ok`]),
    onError: (e) => message.error(errorText(e)),
    onSettled: () => invalidateAll(qc),
  });
}

/** PUT a policy. The caller shows the success text (it depends on the outcome). */
export function useUpdatePolicy() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  return useMutation({
    mutationFn: (v: { targetType: string; action: string; update: PolicyUpdate }) => updatePolicy(v.targetType, v.action, v.update),
    onError: (e) => message.error(errorText(e)),
    onSettled: () => invalidateAll(qc),
  });
}
