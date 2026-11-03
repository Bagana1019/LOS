'use client';
import { useState } from 'react';
import { Alert, Button, Card, Descriptions, Flex, Input, List, Modal, Progress, Skeleton, Steps, Tag, Typography, App as AntApp } from 'antd';
import type { ApprovalTimelineLevel } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { formatDateTime, formatMnt } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useDecision, useVote } from './decision.api';

interface Props { applicationId: string; onChanged?: () => void }
const stepStatus = (s: ApprovalTimelineLevel['state']) => (s === 'APPROVED' ? 'finish' : s === 'PENDING' ? 'process' : s === 'RETURNED' ? 'error' : 'wait') as 'finish' | 'process' | 'error' | 'wait';

/** Wizard-н 9-р алхам "Шийдвэр" (`/los/loan-application/:id/decision`): хураангуй, батлах урсгал, санал өгөх. FR-10. Илгээх товч нь wizard-ийн зүүн самбарт. */
export function DecisionStep({ applicationId, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const q = useDecision(applicationId);
  const vote = useVote(applicationId, onChanged);
  const [returning, setReturning] = useState(false);
  const [comment, setComment] = useState('');
  if (q.isLoading) return <Skeleton active />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const s = d.summary;
  const levels = d.approval.levels;
  const current = Math.max(0, levels.findIndex((l) => l.state === 'PENDING'));
  const send = (decision: 'APPROVE' | 'RETURN', text?: string) => vote.mutateAsync({ decision, ...(text ? { comment: text } : {}) }).then(() => { setReturning(false); setComment(''); void message.success(t(decision === 'APPROVE' ? 'decide.approved' : 'decide.returned')); }).catch(() => undefined);

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" wrap gap={8}>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('decide.title')}</Typography.Title>
        <Tag data-testid="decision-status">{t(`status.${d.status}`)}</Tag>
      </Flex>
      <Card size="small" title={t('decide.summary')}>
        <Descriptions size="small" column={{ xs: 1, md: 2 }}>
          <Descriptions.Item label={t('decide.borrower')}>{s.borrowerName ?? '—'} {s.registerNoMasked ?? ''}</Descriptions.Item>
          <Descriptions.Item label={t('decide.product')}>{s.productName ?? '—'}</Descriptions.Item>
          <Descriptions.Item label={t('decide.amount')}>{s.amount != null ? formatMnt(s.amount) : '—'}</Descriptions.Item>
          <Descriptions.Item label={t('decide.term')}>{s.termMonths ?? '—'}</Descriptions.Item>
          <Descriptions.Item label={t('decide.rate')}>{s.interestRate ?? '—'}</Descriptions.Item>
          <Descriptions.Item label={t('decide.monthly')}>{s.monthlyPayment != null ? formatMnt(s.monthlyPayment) : '—'}</Descriptions.Item>
          <Descriptions.Item label={t('decide.collateral')}>{s.collateralCount}</Descriptions.Item>
          <Descriptions.Item label={t('decide.method')}>{s.selectedMethod ?? '—'}</Descriptions.Item>
        </Descriptions>
        <Progress percent={d.progress.total ? Math.round((d.progress.completed / d.progress.total) * 100) : 0} size="small" format={() => `${d.progress.completed}/${d.progress.total}`} />
        {d.progress.missing.length ? <Alert type="warning" showIcon style={{ marginTop: 8 }} message={t('decide.missing', { steps: d.progress.missing.map((k) => t(`application.step.${k}`)).join(', ') })} /> : null}
      </Card>
      {levels.length ? (
        <Card size="small" title={t('decide.flow')}>
          <Steps direction="vertical" size="small" current={current} items={levels.map((l) => ({
            title: `${l.levelNo}. ${l.name}`, status: stepStatus(l.state),
            description: (
              <div>
                <Tag>{t(`decide.level.${l.state}`)}</Tag>{l.overdue ? <Tag color="error">{t('decide.overdue')}</Tag> : null}
                <span>{t('decide.quorum', { required: l.quorum.required, total: l.quorum.total })}</span>
                {l.dueAt ? <div>{t('decide.due', { date: formatDateTime(l.dueAt) })}</div> : null}
                {l.votes.map((v) => <div key={v.approverId}>{t(`decide.vote.${v.decision}`)} · {formatDateTime(v.decidedAt)}{v.comment ? ` — ${v.comment}` : ''}</div>)}
              </div>
            ),
          }))} />
        </Card>
      ) : <Alert type="info" showIcon message={d.canSubmit ? t('decide.readyToSubmit') : t('decide.notSubmitted')} />}
      {d.canVote ? (
        <Flex gap={8}>
          <Button type="primary" loading={vote.isPending} data-testid="vote-approve" onClick={() => Modal.confirm({ title: t('decide.confirmApprove'), okText: t('decide.approve'), cancelText: t('decide.cancel'), onOk: () => send('APPROVE') })}>{t('decide.approve')}</Button>
          <Button danger data-testid="vote-return" onClick={() => setReturning(true)}>{t('decide.return')}</Button>
        </Flex>
      ) : null}
      {vote.error ? <ApiErrorAlert error={vote.error} /> : null}
      {d.decisionRecord ? (
        <Alert type="success" showIcon message={t('decide.record', { no: d.decisionRecord.decisionNo, date: formatDateTime(d.decisionRecord.decidedAt) })} description={d.decisionRecord.contractNo ? t('decide.contractNo', { no: d.decisionRecord.contractNo }) : undefined} />
      ) : null}
      {d.versions.length > 1 || d.versions.some((v) => v.returnedComment) ? (
        <Card size="small" title={t('decide.versions')}>
          <List size="small" dataSource={d.versions} renderItem={(v) => <List.Item>v{v.version} · {t(`decide.outcome.${v.outcome}`)}{v.returnedComment ? ` — ${v.returnedComment}` : ''}</List.Item>} />
        </Card>
      ) : null}
      <Modal open={returning} title={t('decide.return')} okText={t('decide.return')} cancelText={t('decide.cancel')} okButtonProps={{ disabled: !comment.trim(), danger: true, loading: vote.isPending }} onOk={() => void send('RETURN', comment.trim())} onCancel={() => setReturning(false)}>
        <Input.TextArea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('decide.returnComment')} data-testid="return-comment" maxLength={1000} />
      </Modal>
    </Flex>
  );
}
