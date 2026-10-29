import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AttachCollateralDocumentRequest, CollateralListResponse, CreateCollateralRequest, ExternalValuationRequest, OwnershipCheckRequest, RegisterPledgeRequest,
  RunEncumbranceCheckRequest, SaveValuationRequest, UpdateCollateralRequest,
} from '@los/contracts';
import { isStaleStateError, retryTransient } from '../documents/shared/api-error';
import * as api from './collateral.api';

// Query түлхүүр: ['collateral', applicationId, 'list' | 'xyp' | 'history' | 'monitoring', …]. Мутаци бүрийн дараа `['collateral', applicationId]`-г бүхэлд нь шинэчилнэ
// (жагсаалт, үнэлгээний түүх). Хариуд өөрчлөгдсөн барьцаа, нийлбэр, G0 орсон ч нэг эх сурвалж (жагсаалт) байлгахын тулд дахин татна.
export const collateralKey = (applicationId: string) => ['collateral', applicationId] as const;
export const collateralListKey = (applicationId: string) => [...collateralKey(applicationId), 'list'] as const;

export function useCollateralList(applicationId: string) {
  return useQuery({ queryKey: collateralListKey(applicationId), queryFn: () => api.fetchCollaterals(applicationId), retry: retryTransient });
}

/** ХУР-ын хөрөнгө: `ownerCustomerId` null бол хүсэлт явахгүй. Хэдэн секундын өмнөх мэдээллийг дахин ашиглахгүй (бүртгэл өөрчлөгдсөн байж болно). */
export function useXypAssets(applicationId: string, ownerCustomerId: string | null) {
  return useQuery({
    queryKey: [...collateralKey(applicationId), 'xyp', ownerCustomerId ?? ''],
    queryFn: () => api.fetchXypAssets(applicationId, ownerCustomerId as string),
    enabled: ownerCustomerId !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

export function useValuationHistory(applicationId: string, collateralId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...collateralKey(applicationId), 'history', collateralId],
    queryFn: () => api.fetchValuationHistory(applicationId, collateralId),
    enabled,
    retry: retryTransient,
  });
}

export function useCollateralMonitoring(withinDays: number) {
  return useQuery({ queryKey: ['collateral', 'monitoring', withinDays], queryFn: () => api.fetchCollateralMonitoring(withinDays), retry: retryTransient });
}

/**
 * Мутаци амжилттай бол өгөгдлийг дахин татаж дуустал хүлээнэ (товч "loading" хэвээр), `onChanged` (жишээ нь wizard-н алхмуудын төлөв) дуудна.
 * 404/409 — сервер дээрх төлөв манайхаас зөрсөн (өөр хүн засчээ, хүсэлтийн төлөв солигдсон) тул дахин татна.
 */
function useCollateralMutation<TVars, TData>(applicationId: string, mutationFn: (vars: TVars) => Promise<TData>, onChanged?: () => void) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: collateralKey(applicationId) });
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

type Cid = { collateralId: string };

export const useCreateCollateral = (aid: string, onChanged?: () => void) =>
  useCollateralMutation(aid, (body: CreateCollateralRequest) => api.createCollateral(aid, body), onChanged);
export const useUpdateCollateral = (aid: string, onChanged?: () => void) =>
  useCollateralMutation(aid, (v: Cid & { body: UpdateCollateralRequest }) => api.updateCollateral(aid, v.collateralId, v.body), onChanged);
export const useRemoveCollateral = (aid: string, onChanged?: () => void) =>
  useCollateralMutation(aid, (v: Cid) => api.removeCollateral(aid, v.collateralId), onChanged);
export const useCheckOwnership = (aid: string, onChanged?: () => void) =>
  useCollateralMutation(aid, (v: Cid & { body: OwnershipCheckRequest }) => api.checkOwnership(aid, v.collateralId, v.body), onChanged);
export const useCheckEncumbrance = (aid: string, onChanged?: () => void) =>
  useCollateralMutation(aid, (v: Cid & { body: RunEncumbranceCheckRequest }) => api.checkEncumbrance(aid, v.collateralId, v.body), onChanged);
export const useSaveValuation = (aid: string, onChanged?: () => void) =>
  useCollateralMutation(aid, (v: Cid & { body: SaveValuationRequest }) => api.saveValuation(aid, v.collateralId, v.body), onChanged);
export const useRecordExternalValuation = (aid: string, onChanged?: () => void) =>
  useCollateralMutation(aid, (v: Cid & { body: ExternalValuationRequest }) => api.recordExternalValuation(aid, v.collateralId, v.body), onChanged);
export const useAttachCollateralDocument = (aid: string, onChanged?: () => void) =>
  useCollateralMutation(aid, (v: Cid & { body: AttachCollateralDocumentRequest }) => api.attachCollateralDocument(aid, v.collateralId, v.body), onChanged);
export const useDetachCollateralDocument = (aid: string, onChanged?: () => void) =>
  useCollateralMutation(aid, (v: Cid & { documentId: string }) => api.detachCollateralDocument(aid, v.collateralId, v.documentId), onChanged);
export const useRegisterPledge = (aid: string, onChanged?: () => void) =>
  useCollateralMutation(aid, (v: Cid & { body: RegisterPledgeRequest }) => api.registerPledge(aid, v.collateralId, v.body), onChanged);
export const useReleaseCollateral = (aid: string, onChanged?: () => void) =>
  useCollateralMutation(aid, (v: Cid) => api.releaseCollateral(aid, v.collateralId), onChanged);

/** Системийн санал: хадгалахгүй (өгөгдөл өөрчлөгдөхгүй) тул жагсаалтыг дахин татахгүй. */
export function useSuggestValuation(applicationId: string) {
  return useMutation({ mutationFn: (v: Cid & { mileageKm?: number }) => api.suggestValuation(applicationId, v.collateralId, v.mileageKm === undefined ? {} : { mileageKm: v.mileageKm }) });
}

/** G0-г дахин тооцох: хариу нь жагсаалттай ижил хэлбэр тул шууд cache-д тавина. */
export function useRecheckCollaterals(applicationId: string, onChanged?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.recheckCollaterals(applicationId),
    onSuccess: (data: CollateralListResponse) => {
      queryClient.setQueryData(collateralListKey(applicationId), data);
      onChanged?.();
    },
  });
}
