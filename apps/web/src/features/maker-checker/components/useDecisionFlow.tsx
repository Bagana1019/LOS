'use client';
import { useState, type ReactNode } from 'react';
import type { ChangeRequestDto } from '@los/contracts';
import { useDecision, type DecisionKind } from '../hooks';
import { isConflict } from '../errors';
import { ApproveModal } from './ApproveModal';
import { RejectModal } from './RejectModal';

/** What the table rows and the drawer need to offer approve / reject / cancel. */
export interface DecisionHandlers {
  /** A decision request is in flight: all action buttons are disabled. */
  busy: boolean;
  /** The request being cancelled right now (cancel has no dialog, so its button shows the spinner). */
  cancelingId: string | null;
  onApprove: (dto: ChangeRequestDto) => void;
  onReject: (dto: ChangeRequestDto) => void;
  onCancel: (dto: ChangeRequestDto) => void;
}

type Dialog = { kind: 'approve' | 'reject'; dto: ChangeRequestDto } | null;

/**
 * One place for the decision workflow. Approve/reject open a comment modal; cancel is confirmed by the
 * caller (Popconfirm) and sent right away. Render `modals` once, pass `handlers` to rows and drawer.
 */
export function useDecisionFlow(): { handlers: DecisionHandlers; modals: ReactNode } {
  const approve = useDecision('approve');
  const reject = useDecision('reject');
  const cancel = useDecision('cancel');
  const [dialog, setDialog] = useState<Dialog>(null);

  const mutations = { approve, reject, cancel };
  const busy = approve.isPending || reject.isPending || cancel.isPending;

  /** Run a decision; true when the dialog may close (success, or 409 where the data is stale anyway). */
  const run = async (kind: DecisionKind, dto: ChangeRequestDto, comment?: string): Promise<boolean> => {
    try {
      await mutations[kind].mutateAsync({ id: dto.id, comment });
      return true;
    } catch (e) {
      return isConflict(e);
    }
  };

  const submit = async (comment: string) => {
    if (dialog && (await run(dialog.kind, dialog.dto, comment))) setDialog(null);
  };

  const handlers: DecisionHandlers = {
    busy,
    cancelingId: cancel.isPending ? (cancel.variables?.id ?? null) : null,
    onApprove: (dto) => setDialog({ kind: 'approve', dto }),
    onReject: (dto) => setDialog({ kind: 'reject', dto }),
    onCancel: (dto) => void run('cancel', dto),
  };

  const modals = (
    <>
      <ApproveModal open={dialog?.kind === 'approve'} loading={approve.isPending} onSubmit={submit} onCancel={() => setDialog(null)} />
      <RejectModal open={dialog?.kind === 'reject'} loading={reject.isPending} onSubmit={submit} onCancel={() => setDialog(null)} />
    </>
  );

  return { handlers, modals };
}
