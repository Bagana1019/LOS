'use client';
import { Space, Tag, Tooltip } from 'antd';
import { mn } from '@los/ui';
import type { ChangeRequestMode, ChangeRequestStatus } from '@los/contracts';
import { MODE_COLOR, modeLabel, statusColor, statusLabel } from '../labels';

interface Props {
  status: ChangeRequestStatus;
  /** DIRECT requests (policy off, applied immediately) get an extra marker. */
  mode?: ChangeRequestMode;
}

export function StatusTag({ status, mode }: Props) {
  return (
    <Space size={4} wrap>
      <Tag color={statusColor(status)} style={{ margin: 0 }}>
        {statusLabel(status)}
      </Tag>
      {mode === 'DIRECT' && (
        <Tooltip title={mn['maker_checker.mode.DIRECT_tooltip']}>
          <Tag color={MODE_COLOR.DIRECT} style={{ margin: 0 }}>
            {modeLabel('DIRECT')}
          </Tag>
        </Tooltip>
      )}
    </Space>
  );
}
