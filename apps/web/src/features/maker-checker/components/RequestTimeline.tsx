'use client';
import { Empty, Tag, Timeline, Typography } from 'antd';
import { mn } from '@los/ui';
import type { ChangeRequestHistoryDto } from '@los/contracts';
import { eventColor, eventLabel, fmt, roleLabel, statusLabel } from '../labels';
import { formatDateTime } from '../time';
import { PersonLabel } from './PersonLabel';

const { Text, Paragraph } = Typography;

/** Audit trail: event, actor, roles, comment, time - oldest first. */
export function RequestTimeline({ history, userName }: { history: ChangeRequestHistoryDto[] | undefined; userName?: (id: string) => string | null }) {
  if (!history || history.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={mn['maker_checker.timeline.empty']} />;
  }
  const items = [...history]
    .sort((a, b) => a.seq - b.seq)
    .map((h) => ({
      key: h.seq,
      color: eventColor(h.event),
      children: (
        <div>
          <Text strong>{eventLabel(h.event)}</Text>
          <Text type="secondary"> · {formatDateTime(h.at)}</Text>
          <div>
            {h.actorId === null ? <Text>{mn['maker_checker.timeline.system']}</Text> : <PersonLabel id={h.actorId} name={userName?.(h.actorId) ?? null} />}{' '}
            {h.actorRoles.map((r) => (
              <Tag key={r}>{roleLabel(r)}</Tag>
            ))}
          </div>
          {h.fromStatus && h.fromStatus !== h.toStatus && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {fmt(mn['maker_checker.timeline.transition'], { from: statusLabel(h.fromStatus), to: statusLabel(h.toStatus) })}
            </Text>
          )}
          {h.comment && (
            <Paragraph style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }} type="secondary">
              {h.comment}
            </Paragraph>
          )}
        </div>
      ),
    }));
  return <Timeline items={items} />;
}
