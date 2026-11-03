import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ScheduleResponse, ScheduleView, type ScheduleParamsRequest } from '@los/contracts';
import { originationDownload, originationFetch } from '../../lib/api';

// FR-7: `/applications/:id/schedule` (GET · preview · POST · export).
const base = (id: string): string => `/applications/${encodeURIComponent(id)}/schedule`;
export const scheduleKey = (id: string) => ['schedule', id] as const;

export const useSchedule = (id: string) => useQuery({ queryKey: scheduleKey(id), queryFn: () => originationFetch(base(id), { schema: ScheduleResponse }), retry: false });
export const usePreviewSchedule = (id: string) => useMutation({ mutationFn: (body: ScheduleParamsRequest) => originationFetch(`${base(id)}/preview`, { method: 'POST', json: body, schema: ScheduleView }) });
export function useGenerateSchedule(id: string, onChanged?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ScheduleParamsRequest) => originationFetch(base(id), { method: 'POST', json: body, schema: ScheduleResponse }),
    onSuccess: (res) => { qc.setQueryData(scheduleKey(id), res); onChanged?.(); },
  });
}
export const exportSchedule = (id: string): Promise<void> => originationDownload(`${base(id)}/export`, 'schedule.xlsx');
