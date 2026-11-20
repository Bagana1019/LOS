'use client';
import { Typography } from 'antd';

export const SECONDARY_SMALL = { fontSize: 12 } as const;

/** A person or branch by name. When the name is unknown the raw id stays, but only as secondary small text - never as the main label (F8-3). */
export function PersonLabel({ id, name }: { id: string; name: string | null }) {
  if (name) return <Typography.Text title={id}>{name}</Typography.Text>;
  return (
    <Typography.Text type="secondary" style={SECONDARY_SMALL}>
      {id}
    </Typography.Text>
  );
}
