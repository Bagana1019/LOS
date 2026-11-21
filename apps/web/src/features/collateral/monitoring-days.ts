import { t } from '../../lib/i18n';
import { plainNumberProblem } from '../admin/plain-number-rules';

/** = `CollateralMonitoringQuery.withinDays` дээд хязгаар (packages/contracts); тест гэрээтэй тулгана. */
export const MONITORING_DAYS_MAX = 3650;

/**
 * "Хэдэн хоногийн дотор" талбарын асуудал (мессеж) эсвэл null. `undefined` = хоосон, `NaN` = тоо биш текст.
 * antd InputNumber-ийн адил чимээгүй clamp/анхдагч утга руу буцаахгүй (F2-8).
 */
export function withinDaysProblem(days: number | undefined): string | null {
  const label = t('collateral.monitoring.withinDays');
  if (days === undefined) return t('admin.num.required', { field: label });
  return plainNumberProblem(days, { label, min: 0, max: MONITORING_DAYS_MAX, integer: true });
}
