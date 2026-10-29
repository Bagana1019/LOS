import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationPreferenceRequest, PreviewTemplateRequest, RecipientType, SendTestRequest, UpsertTemplateRequest } from '@los/contracts';
import * as api from './notifications.api';
import { retryTransient, type DeliveryFilter } from './notifications.utils';

// ADMIN / BRANCH_MANAGER-ийн хэсэг. Түлхүүр нь ажилтны хонхны ['notifications']-ээс тусдаа: уншсан болгоход эдгээр дахин татагдахгүй.
export const adminKeys = {
  templates: ['notification-admin', 'templates'] as const,
  preview: (req: PreviewTemplateRequest) => ['notification-admin', 'preview', req] as const,
  deliveries: (filter: DeliveryFilter) => ['notification-admin', 'deliveries', filter] as const,
  deliveriesAll: ['notification-admin', 'deliveries'] as const,
  preferences: (type: RecipientType, id: string) => ['notification-admin', 'preferences', type, id] as const,
};

export function useTemplates() {
  return useQuery({ queryKey: adminKeys.templates, queryFn: api.fetchTemplates, retry: retryTransient });
}

export function useUpsertTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpsertTemplateRequest) => api.upsertTemplate(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adminKeys.templates }),
  });
}

/** POST боловч уншилт: хүсэлт бүр өөр түлхүүртэй тул хамгийн сүүлийнх нь л үр дүн болно (хуучин хариу дарахгүй). */
export function useTemplatePreview(request: PreviewTemplateRequest | null) {
  return useQuery({
    queryKey: adminKeys.preview(request ?? { type: 'PAYMENT_DUE', channel: 'SMS', body: '-' }),
    queryFn: () => api.previewTemplate(request as PreviewTemplateRequest),
    enabled: request !== null,
    staleTime: Infinity,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useDeliveries(filter: DeliveryFilter) {
  return useQuery({ queryKey: adminKeys.deliveries(filter), queryFn: () => api.fetchDeliveries(filter), placeholderData: keepPreviousData, staleTime: 0, retry: retryTransient });
}

/** Туршилтын мессеж хүргэлтийн бүртгэлд орох тул тэр жагсаалтыг шинэчилнэ. */
export function useSendTest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SendTestRequest) => api.sendTest(body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: adminKeys.deliveriesAll }),
  });
}

export function useRunReminders() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { asOf?: string; dryRun: boolean }) => api.runReminders(body),
    onSuccess: (_res, vars) => (vars.dryRun ? undefined : queryClient.invalidateQueries({ queryKey: adminKeys.deliveriesAll })),
  });
}

export function usePreferences(recipientType: RecipientType, recipientId: string | null) {
  return useQuery({
    queryKey: adminKeys.preferences(recipientType, recipientId ?? ''),
    queryFn: () => api.fetchPreferences(recipientType, recipientId as string),
    enabled: recipientId !== null,
    staleTime: 0,
    retry: retryTransient,
  });
}

export function useSavePreferences(recipientType: RecipientType, recipientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: NotificationPreferenceRequest) => api.putPreferences(recipientType, recipientId, body),
    onSuccess: (view) => queryClient.setQueryData(adminKeys.preferences(recipientType, recipientId), view),
  });
}
