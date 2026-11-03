import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from './customers.api';

export const customersKey = ['customers'] as const;

const retryTransient = (failureCount: number, error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return failureCount < 1 && !(typeof status === 'number' && status < 500);
};

export const useCustomerList = (params: api.CustomerListParams) =>
  useQuery({ queryKey: [...customersKey, 'list', params], queryFn: () => api.fetchCustomers(params), placeholderData: keepPreviousData, retry: retryTransient });

export const useCustomerCard = (id: string) =>
  useQuery({ queryKey: [...customersKey, 'card', id], queryFn: () => api.fetchCustomerCard(id), retry: retryTransient, refetchOnMount: 'always' });

export const useXypFetch = () => useMutation({ mutationFn: (registerNo: string) => api.xypFetch(registerNo) });

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: Record<string, unknown>) => api.createCustomer(body), onSuccess: () => qc.invalidateQueries({ queryKey: customersKey }) });
}
