'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { App as AntApp, Alert, Button, Input, Modal } from 'antd';
import type { ApprovalDecision, MyApprovalItem } from '@los/contracts';
import { t } from '../../lib/i18n';
import { applicationHref, describeApplicationError } from './applications.utils';
import { buildVoteRequest, isStaleVoteError } from './my-approvals';
import { MyApprovalsTable } from './MyApprovalsTable';
import { useListVote, useMyApprovals } from './useApplications';
import { VoteTargetSummary } from './VoteTargetSummary';

/** FR-1.5: санал өгөгчийн ХАРСАН түвшин, хувилбар — хоцорсон жагсаалтаас өөр шийдвэрт санал өгөхгүй (сервер 409 VOTE_TARGET_CHANGED). */
const targetOf = (item: MyApprovalItem) => ({ levelNo: item.levelNo, version: item.version });

/**
 * FR-1.1 / FR-1.5: "Миний батлах" таб — санал хүлээж буй хүсэлтүүд, мөр бүрт Батлах / Буцаах. Байгаа санал өгөх API-г ашиглана
 * (Буцаахад тайлбар заавал; өөрийн хүсэлтийг батлахгүй, түвшний гишүүнчлэлийг сервер шалгана — алдааг серверийн мессежээр харуулна).
 * Цонх бүр юунд (хүсэлт, түвшин, дүн) санал өгч байгааг харуулж, харсан түвшин/хувилбараа серверт дамжуулна. 409 → жагсаалт шинэчлэгдэж, цонх хаагдана.
 * Санал өгсний дараа (амжилттай ч, алдаатай ч) жагсаалт, тоолуур шинэчлэгдэнэ (`useListVote`).
 */
export function MyApprovalsPanel() {
  const router = useRouter();
  const { message, modal } = AntApp.useApp();
  const mine = useMyApprovals(true);
  const vote = useListVote();
  const [returning, setReturning] = useState<MyApprovalItem | null>(null);
  const [reason, setReason] = useState('');

  const cancelReturn = () => { setReturning(null); setReason(''); };

  const send = async (item: MyApprovalItem, decision: ApprovalDecision, comment?: string): Promise<void> => {
    const body = buildVoteRequest(decision, comment, targetOf(item));
    if (!body) return;
    try {
      await vote.mutateAsync({ applicationId: item.applicationId, body });
      cancelReturn();
      void message.success(t(decision === 'APPROVE' ? 'decide.approved' : 'decide.returned'));
    } catch (e) {
      if (isStaleVoteError(e)) cancelReturn(); // бичсэн шалтгаан нь өөрчлөгдсөн шийдвэрт зориулагдсан байсан
      void message.error(describeApplicationError(e, 'application.mine.voteFailed'));
    }
  };

  const confirmApprove = (item: MyApprovalItem) => modal.confirm({
    title: t('decide.confirmApprove'), content: <VoteTargetSummary item={item} />, okText: t('decide.approve'), cancelText: t('decide.cancel'), onOk: () => send(item, 'APPROVE'),
  });

  return (
    <>
      {mine.isError ? <Alert type="error" showIcon message={t('application.list.error')} action={<Button size="small" onClick={() => void mine.refetch()}>{t('application.list.retry')}</Button>} style={{ marginBottom: 12 }} /> : null}
      <MyApprovalsTable
        items={mine.data?.items ?? []}
        loading={mine.isFetching}
        busy={vote.isPending}
        onOpen={(id) => router.push(applicationHref(id))}
        onApprove={confirmApprove}
        onReturn={(item) => { setReason(''); setReturning(item); }}
      />
      <Modal
        open={returning !== null}
        title={returning ? `${t('decide.return')} · ${returning.appNo}` : t('decide.return')}
        okText={t('decide.return')}
        cancelText={t('decide.cancel')}
        okButtonProps={{ danger: true, disabled: !buildVoteRequest('RETURN', reason), loading: vote.isPending }}
        onOk={() => { if (returning) void send(returning, 'RETURN', reason); }}
        onCancel={cancelReturn}
      >
        {returning ? <VoteTargetSummary item={returning} /> : null}
        <Input.TextArea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('decide.returnComment')} data-testid="mine-return-comment" maxLength={1000} />
      </Modal>
    </>
  );
}
