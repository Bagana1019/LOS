import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ContractView, OfficialLetterView, type CreateOfficialLetterRequest } from '@los/contracts';
import { originationFetch } from '../../lib/api';

// FR-11: `/applications/:id/contract…` (гэрээ, цаасан скан, албан бичиг). Цахим гарын үсэг: features/contract-signing.
export const ContractDocs = z.object({ contract: ContractView.nullable(), letters: z.array(OfficialLetterView) });
export type ContractDocs = z.infer<typeof ContractDocs>;
const base = (id: string): string => `/applications/${encodeURIComponent(id)}/contract`;
export const contractKey = (id: string) => ['contract', id] as const;

export const useContractDocs = (id: string) => useQuery({ queryKey: contractKey(id), queryFn: () => originationFetch(base(id), { schema: ContractDocs }), retry: false });

function useDocsMutation<V>(id: string, fn: (v: V) => Promise<unknown>, onChanged?: () => void) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => { void qc.invalidateQueries({ queryKey: contractKey(id) }); onChanged?.(); } });
}
export const useGenerateContract = (id: string, onChanged?: () => void) => useDocsMutation(id, () => originationFetch(`${base(id)}/generate`, { method: 'POST' }), onChanged);
export const useAttachSigned = (id: string, onChanged?: () => void) => useDocsMutation(id, (fileId: string) => originationFetch(`${base(id)}/signed`, { method: 'POST', json: { fileId } }), onChanged);
export const useCreateLetter = (id: string, onChanged?: () => void) => useDocsMutation(id, (body: CreateOfficialLetterRequest) => originationFetch(`${base(id)}/official-letters`, { method: 'POST', json: body }), onChanged);
export const usePrintLetter = (id: string, onChanged?: () => void) => useDocsMutation(id, (letterId: string) => originationFetch(`${base(id)}/official-letters/${encodeURIComponent(letterId)}/print`, { method: 'POST' }), onChanged);
