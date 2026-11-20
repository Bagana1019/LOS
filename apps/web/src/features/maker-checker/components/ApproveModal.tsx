'use client';
import { mn } from '@los/ui';
import type { RangeWarning } from '../range-warnings';
import { CommentModal } from './CommentModal';
import { RangeWarningsAlert } from './RangeWarningsAlert';

interface Props {
  open: boolean;
  loading: boolean;
  /** Non-blocking notices for odd values (F9-5); the approver may still confirm. */
  warnings?: readonly RangeWarning[];
  onSubmit: (comment: string) => void;
  onCancel: () => void;
}

/** Approve with an optional comment. */
export function ApproveModal({ open, loading, warnings = [], onSubmit, onCancel }: Props) {
  return (
    <CommentModal
      open={open}
      loading={loading}
      required={false}
      notice={
        warnings.length > 0 ? (
          <div style={{ marginBottom: 12 }}>
            <RangeWarningsAlert warnings={warnings} />
          </div>
        ) : undefined
      }
      title={mn['maker_checker.approve.title']}
      hint={mn['maker_checker.approve.hint']}
      label={mn['maker_checker.approve.comment_label']}
      placeholder={mn['maker_checker.approve.comment_placeholder']}
      okText={mn['maker_checker.btn.approve']}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}
