import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AttachDocumentRequest } from '@los/contracts';
import { isStaleStateError, retryTransient } from './shared/api-error';
import * as api from './documents.api';

export const documentsKey = (applicationId: string) => ['documents', applicationId] as const;

export function useDocumentList(applicationId: string) {
  return useQuery({ queryKey: documentsKey(applicationId), queryFn: () => api.fetchDocuments(applicationId), retry: retryTransient });
}

/** Амжилттай бол жагсаалтыг дахин татаж дуустал хүлээнэ; 404/409 (төлөв зөрсөн) үед мөн дахин татна. */
function useDocumentMutation<TVars, TData>(applicationId: string, mutationFn: (vars: TVars) => Promise<TData>, onChanged?: () => void) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: documentsKey(applicationId) });
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await refresh();
      onChanged?.();
    },
    onError: (error) => {
      if (isStaleStateError(error)) void refresh();
    },
  });
}

export const useAttachDocument = (applicationId: string, onChanged?: () => void) =>
  useDocumentMutation(applicationId, (body: AttachDocumentRequest) => api.attachDocument(applicationId, body), onChanged);

export const useRemoveDocument = (applicationId: string, onChanged?: () => void) =>
  useDocumentMutation(applicationId, (v: { documentId: string }) => api.removeDocument(applicationId, v.documentId), onChanged);

/** OCR нь өгөгдөл өөрчлөхгүй (зөвлөмж) тул жагсаалтыг дахин татахгүй. */
export const useOcrCheck = (applicationId: string) => useMutation({ mutationFn: (v: { documentId: string }) => api.ocrCheckDocument(applicationId, v.documentId) });
