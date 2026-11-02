import { t } from '../../lib/i18n';
import { canEditContent, editBlockedReason, type WriteState } from '../documents/shared/access';

export interface Gate {
  disabled: boolean;
  /** Идэвхгүй болгосон шалтгаан (tooltip / title). */
  text: string | undefined;
}

const reasonText = (r: ReturnType<typeof editBlockedReason>): string | undefined => (r === 'role' ? t('collateral.gate.readOnlyRole') : r === 'status' ? t('collateral.gate.notEditable') : undefined);

/** DRAFT/RETURNED шаарддаг үйлдэл (нэмэх, засах, шалгах, баримт). */
export function contentGate(write: WriteState): Gate {
  return { disabled: !canEditContent(write), text: reasonText(editBlockedReason(write)) };
}

/**
 * Үнэлгээ, гадны үнэлгээ, ЭБ бүртгэл, чөлөөлөлт: хүсэлтийн төлөв DRAFT/RETURNED-оос өөр (ACTIVE, APPROVED, CLOSED …) үед ч зөвшөөрөгддөг тул
 * UI зөвхөн дүрээр хаана; төлвийн хориг серверийн 409 (монгол мессежтэй).
 */
export function canWriteBlocked(write: WriteState): Gate {
  return { disabled: !write.canWrite, text: write.canWrite ? undefined : t('collateral.gate.readOnlyRole') };
}
