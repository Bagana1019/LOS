import type { PosLeaseStatus, PosLeaseView } from '@los/contracts';
import { Timeline } from 'antd';
import { formatDateTime } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { actorLabel, statusLabel, timelineActionLabel } from '../status';
import { MP_COLORS } from '../theme';

const DOT: Partial<Record<PosLeaseStatus, string>> = {
  APPROVED: MP_COLORS.success, ACCEPTED: MP_COLORS.primary, DELIVERED: MP_COLORS.primary, SETTLED: MP_COLORS.success, DECLINED: MP_COLORS.danger, CANCELLED: '#8c97a8', EXPIRED: MP_COLORS.warning, REFERRED: MP_COLORS.warning,
};

/** Лизингийн явц (POS-FR-11). Оролцогчийг зөвхөн дүрээр (Систем / Худалдан авагч / Мерчант / Лизингийн байгууллага) нэрлэнэ — ID харуулахгүй. */
export function LeaseTimeline({ timeline }: { timeline: PosLeaseView['timeline'] }) {
  return (
    <Timeline
      className="mp-timeline"
      items={timeline.map((e, i) => ({
        key: `${e.at}-${i}`,
        color: (e.toStatus && DOT[e.toStatus]) || MP_COLORS.muted,
        children: (
          <div className="mp-tl-item">
            <strong>{timelineActionLabel(e.action)}</strong>
            <div className="mp-tl-meta">{formatDateTime(e.at)} · {actorLabel(e.actor)}</div>
            {e.toStatus && e.fromStatus !== e.toStatus ? (
              <div className="mp-tl-status">{t('pos.timeline.statusChange', { from: e.fromStatus ? statusLabel(e.fromStatus) : '—', to: statusLabel(e.toStatus) })}</div>
            ) : null}
          </div>
        ),
      }))}
    />
  );
}
