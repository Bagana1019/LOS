'use client';
import { Button, Popconfirm, Space, type ButtonProps } from 'antd';
import { mn } from '@los/ui';
import type { ChangeRequestDto } from '@los/contracts';
import { describeChange, fmt } from '../labels';
import type { DecisionHandlers } from './useDecisionFlow';

interface Props {
  dto: ChangeRequestDto;
  handlers: DecisionHandlers;
  /** Show "Дэлгэрэнгүй" (table rows); the drawer is already the detail view. */
  onDetails?: (id: string) => void;
  /** row = compact link buttons for the table, footer = regular buttons for the drawer. */
  variant: 'row' | 'footer';
}

const ROW_BUTTON: ButtonProps = { type: 'link', size: 'small', style: { paddingInline: 4 } };

/** Buttons are driven by the server flags canDecide / canCancel only - permissions are never re-derived here. */
export function RequestActions({ dto, handlers, onDetails, variant }: Props) {
  const row = variant === 'row';
  const { busy, cancelingId } = handlers;
  const base: ButtonProps = row ? ROW_BUTTON : {};
  // Rows repeat "Дэлгэрэнгүй"; screen readers need to know which request it opens.
  const detailsLabel = fmt(mn['maker_checker.table.open_aria'], { name: `${describeChange(dto.targetType, dto.action).title} ${dto.targetId}` });

  return (
    // Clicks here must not open the row's detail drawer.
    <Space size={row ? 2 : 8} wrap onClick={(e) => e.stopPropagation()}>
      {onDetails && (
        <Button {...base} aria-label={detailsLabel} onClick={() => onDetails(dto.id)}>
          {mn['maker_checker.btn.details']}
        </Button>
      )}
      {dto.canDecide === true && (
        <>
          <Button {...base} type={row ? 'link' : 'primary'} disabled={busy} onClick={() => handlers.onApprove(dto)}>
            {mn['maker_checker.btn.approve']}
          </Button>
          <Button {...base} danger disabled={busy} onClick={() => handlers.onReject(dto)}>
            {mn['maker_checker.btn.reject']}
          </Button>
        </>
      )}
      {dto.canCancel === true && (
        <Popconfirm
          title={mn['maker_checker.cancel.title']}
          description={mn['maker_checker.cancel.desc']}
          okText={mn['maker_checker.cancel.ok']}
          cancelText={mn['maker_checker.cancel.no']}
          okButtonProps={{ danger: true }}
          disabled={busy}
          onConfirm={() => handlers.onCancel(dto)}
        >
          <Button {...base} danger disabled={busy} loading={cancelingId === dto.id}>
            {mn['maker_checker.btn.cancel']}
          </Button>
        </Popconfirm>
      )}
    </Space>
  );
}
