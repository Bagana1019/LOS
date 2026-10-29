import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CalcMethod, ScoreOverview, ScoreTerms } from '@los/contracts';
import * as api from './score.api';
import { overviewKey, overviewQueryOptions, previewQueryOptions, previewRootKey } from './score.query';
import { debounceMode, isDirty, isPreviewPending, isStaleStateError, previewFetchEnabled, reconcileDraft, termsKey, type DraftState } from './score.utils';

/** FR-8.3: slider-ийн хүсэлтийг ~350 мс тогтворжсоны дараа илгээнэ. */
export const PREVIEW_DEBOUNCE_MS = 350;

export const useScoreOverview = (applicationId: string) => useQuery(overviewQueryOptions(applicationId));

/**
 * Slider-ийн ноорог. `base` (серверийн хадгалсан нөхцөл) өөрчлөгдвөл ноорог шинэ суурь руу сэргэнэ
 * (render дундах derived state — effect-гүй тул нэг frame-д зөрөхгүй).
 */
export function useTermsDraft(base: ScoreTerms | null) {
  const [state, setState] = useState<DraftState>({ base, draft: base });
  let current = state;
  const reconciled = reconcileDraft(state, base);
  if (reconciled !== state) {
    setState(reconciled);
    current = reconciled;
  }
  return {
    draft: current.draft,
    dirty: isDirty(current),
    update: (patch: Partial<ScoreTerms>) => setState((s) => ({ ...s, draft: s.draft ? { ...s.draft, ...patch } : s.draft })),
    reset: () => setState((s) => ({ ...s, draft: s.base })),
  };
}

/**
 * Slider → preview. `draft` null (хүчингүй утга) эсвэл `enabled=false` бол хүсэлт явуулахгүй.
 * Latest-wins: query түлхүүр утгаараа тул хоцорсон хариу харагдахгүй. Debounce хүлээж буй (`debounced` != `draft`) үед хүсэлт явуулахгүй. Эхний хүчинтэй утгыг debounce хийхгүй (хуудас нээгдэнгүүт тооцоолно).
 * `pending` = debounce хүлээж буй эсвэл хүсэлт явж буй.
 */
export function useScorePreview(applicationId: string, draft: ScoreTerms | null, enabled: boolean) {
  const [debounced, setDebounced] = useState<ScoreTerms | null>(draft);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const debouncedRef = useRef(debounced);
  debouncedRef.current = debounced;
  const key = termsKey(draft);
  useEffect(() => {
    if (debounceMode(debouncedRef.current, draftRef.current) === 'immediate') {
      setDebounced(draftRef.current);
      return undefined;
    }
    const id = setTimeout(() => setDebounced(draftRef.current), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [key]);

  const query = useQuery(previewQueryOptions(applicationId, debounced, previewFetchEnabled(enabled, draft, debounced)));
  const pending = isPreviewPending({ enabled, draft, debounced, fetching: query.isFetching });
  return { data: query.data ?? null, error: query.isError ? query.error : null, pending, refetch: () => void query.refetch() };
}

/** Тооцоолж хадгалах. Амжилттай бол overview-г шууд солино (серверийн хариу = шинэ overview), preview кэшийг цэвэрлэнэ. */
export function useCalculate(applicationId: string, onDone?: (overview: ScoreOverview) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.calculateScore(applicationId),
    onSuccess: async (overview) => {
      await qc.cancelQueries({ queryKey: overviewKey(applicationId) }); // нисэж буй хуучин таталт шинэ өгөгдлийг дарахаас сэргийлнэ
      qc.setQueryData(overviewKey(applicationId), overview);
      qc.removeQueries({ queryKey: previewRootKey(applicationId) });
      onDone?.(overview);
    },
    onError: (error) => {
      if (isStaleStateError(error)) void qc.invalidateQueries({ queryKey: overviewKey(applicationId) });
    },
  });
}

/** Арга сонгох (Q-M8-8: тайлбар заавал биш). 409/422 бол сервер дээрх төлөв зөрсөн тул overview-г дахин татна. */
export function useSelectMethod(applicationId: string, onDone?: (overview: ScoreOverview, method: CalcMethod) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { method: CalcMethod; reason?: string }) => api.selectScoreMethod(applicationId, { method: v.method, ...(v.reason ? { reason: v.reason } : {}) }),
    onSuccess: async (overview, v) => {
      await qc.cancelQueries({ queryKey: overviewKey(applicationId) });
      qc.setQueryData(overviewKey(applicationId), overview);
      onDone?.(overview, v.method);
    },
    onError: (error) => {
      if (isStaleStateError(error)) void qc.invalidateQueries({ queryKey: overviewKey(applicationId) });
    },
  });
}
