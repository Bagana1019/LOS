import { useQuery } from '@tanstack/react-query';
import { fetchApplication } from '../applications/applications.api';
import { applicationDetailKey } from '../applications/useApplications';
import type { StageCounts } from './decision.risk';

/**
 * F3-1: wizard-ийн зүүн самбарын «Бүрдсэн: done/total» тоолуурын тоо. ApplicationWizard-ийн ижил query-г (`applicationDetailKey`) КЭШЭЭС уншина — `enabled: false`
 * тул нэмэлт GET үүсгэхгүй, wizard шинэчлэгдэх үед хамт шинэчлэгдэнэ. Кэшэнд байхгүй бол null (шийдвэрийн хуудас заавал бүрдэх алхмаар үлдэнэ).
 * Тусдаа файл: `useApplications` нь `decision.api`-г импортолдог тул `decision.api`-д оруулбал цикл үүснэ.
 */
export function useWizardStageCounts(applicationId: string): StageCounts | null {
  const q = useQuery({
    queryKey: applicationDetailKey(applicationId), queryFn: () => fetchApplication(applicationId), enabled: false,
    select: (a): StageCounts => ({ completed: a.stage1Completed, total: a.stage1Total }),
  });
  return q.data ?? null;
}
