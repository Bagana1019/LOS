import type { ApprovalLevelApprover, CannotVoteReason, DecisionView, OrgDirectory } from '@los/contracts';
import { hasMessage, t } from '../../lib/i18n';
import { directoryLabels } from '../applications/directory';

/** F3-11: «Та энэ түвшний батлагч биш» гэх мэт — яагаад санал өгч чадахгүйг. Шалтгаангүй (санал өгч болно) бол null. */
export const cannotVoteMessage = (reason: CannotVoteReason | null): string | null => (reason ? t(`decide.cannotVote.${reason}`) : null);

/** Шалтгааныг зөвхөн санал авч буй хүсэлтэд харуулна; бусад төлөвт (ноорог, батлагдсан, буцаасан) хуудас өөрөө төлвөө хэлдэг тул давтахгүй. */
export const showCannotVote = (d: Pick<DecisionView, 'status' | 'canVote' | 'cannotVoteReason'>): boolean =>
  d.status === 'IN_APPROVAL' && !d.canVote && d.cannotVoteReason !== null;

const roleLabel = (role: string | null, unknown: string): string => (role && hasMessage(`auth.role.${role}`) ? t(`auth.role.${role}`) : unknown);

/**
 * «Батлах эрхтэй: <нэрс>». Хэрэглэгчээр томилсон бол `/directory`-оос нэр (олдохгүй бол «Тодорхойгүй» — UUID хэзээ ч биш); дүрээр томилсон бол дүрийн шошго.
 * Origination-д нэр байхгүй (нэр нь gateway iam schema-д) тул сервер зөвхөн id / дүр өгдөг.
 */
export function approversLine(approvers: readonly ApprovalLevelApprover[], directory: OrgDirectory | undefined, loading: boolean): string {
  if (!approvers.length) return t('decide.approvers.none');
  const unknown = t('application.directory.unknown');
  const labels = directoryLabels(directory, loading, { unknown, system: unknown });
  const names = approvers.map((a) => (a.userId ? labels.officer(a.userId) : roleLabel(a.role, unknown)));
  return t('decide.approvers', { names: names.join(', ') });
}
