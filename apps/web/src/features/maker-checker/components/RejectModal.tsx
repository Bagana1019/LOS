'use client';
import { mn } from '@los/ui';
import { fmt } from '../labels';
import { COMMENT_MIN } from '../validation';
import { CommentModal } from './CommentModal';

interface Props {
  open: boolean;
  loading: boolean;
  onSubmit: (comment: string) => void;
  onCancel: () => void;
}

/** Reject needs a comment of at least 3 characters (MC-BR-4). */
export function RejectModal({ open, loading, onSubmit, onCancel }: Props) {
  return (
    <CommentModal
      open={open}
      loading={loading}
      required
      okDanger
      title={mn['maker_checker.reject.title']}
      hint={mn['maker_checker.reject.hint']}
      label={mn['maker_checker.reject.comment_label']}
      placeholder={fmt(mn['maker_checker.reject.comment_placeholder'], { min: COMMENT_MIN })}
      okText={mn['maker_checker.btn.reject']}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}
