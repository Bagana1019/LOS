'use client';
import { mn } from '@los/ui';
import { CommentModal } from './CommentModal';

interface Props {
  open: boolean;
  loading: boolean;
  onSubmit: (comment: string) => void;
  onCancel: () => void;
}

/** Approve with an optional comment. */
export function ApproveModal({ open, loading, onSubmit, onCancel }: Props) {
  return (
    <CommentModal
      open={open}
      loading={loading}
      required={false}
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
