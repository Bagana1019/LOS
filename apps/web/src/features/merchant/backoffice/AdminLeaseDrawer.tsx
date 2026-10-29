'use client';
import { PosLeaseReview, PosLeaseSettle, type PosLeaseAdminView, type PosReasonSeverity } from '@los/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Drawer, Form, Input, Radio, Skeleton } from 'antd';
import { formatDateTime, formatDuration, formatMnt, formatPercent } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { backOfficeKeys, getAdminLease, reviewLease, settleLease } from '../../../lib/merchant-api';
import { errorMessage } from '../errors';
import { StatusTag, ToneTag } from '../StatusTag';
import type { TagTone } from '../tag-tones';
import { LeaseTimeline } from '../leases/LeaseTimeline';
import { QuoteBreakdown } from '../leases/QuoteBreakdown';
import { ErrorState } from '../states';

const SEVERITY_COLOR: Record<PosReasonSeverity, TagTone> = { DECLINE: 'red', REFER: 'gold', INFO: 'blue' };

function Dl({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return <dl className="mp-dl">{rows.map(([k, v]) => <div key={k} className="mp-dl-row"><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

function useAdminLeaseMutations(id: string) {
  const qc = useQueryClient();
  const apply = (lease: PosLeaseAdminView) => {
    qc.setQueryData(backOfficeKeys.lease(id), lease);
    void qc.invalidateQueries({ queryKey: backOfficeKeys.leasesAll() });
  };
  return {
    review: useMutation({ mutationFn: (v: { decision: 'APPROVE' | 'DECLINE'; comment: string }) => reviewLease(id, PosLeaseReview.parse(v)), onSuccess: apply }),
    settle: useMutation({ mutationFn: (v: { settlementRef: string }) => settleLease(id, PosLeaseSettle.parse(v)), onSuccess: apply }),
  };
}

function ReviewForm({ id }: { id: string }) {
  const { review } = useAdminLeaseMutations(id);
  const [form] = Form.useForm<{ decision: 'APPROVE' | 'DECLINE'; comment: string }>();
  return (
    <section className="mp-panel mp-admin-action" aria-labelledby="review-h">
      <h3 id="review-h" className="mp-subtitle">{t('admin.review.title')}</h3>
      <p className="mp-muted">{t('admin.review.text')}</p>
      {review.isError ? <Alert className="mp-banner" type="error" showIcon role="alert" message={errorMessage(review.error)} /> : null}
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => review.mutate(v)} disabled={review.isPending}>
        <Form.Item validateFirst name="decision" label={t('admin.review.decision')} rules={[{ required: true, message: t('validation.decision') }]}>
          <Radio.Group optionType="button" buttonStyle="solid" options={[{ value: 'APPROVE', label: t('admin.review.approve') }, { value: 'DECLINE', label: t('admin.review.decline') }]} />
        </Form.Item>
        <Form.Item validateFirst name="comment" label={t('admin.review.comment')} rules={[{ required: true, whitespace: true, message: t('validation.comment') }, { min: 3, max: 500, message: t('validation.comment') }]}>
          <Input.TextArea rows={3} maxLength={500} showCount placeholder={t('admin.review.comment.placeholder')} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={review.isPending}>{t('admin.review.submit')}</Button>
      </Form>
    </section>
  );
}

function SettleForm({ id, net }: { id: string; net: number }) {
  const { settle } = useAdminLeaseMutations(id);
  const [form] = Form.useForm<{ settlementRef: string }>();
  return (
    <section className="mp-panel mp-admin-action" aria-labelledby="settle-h">
      <h3 id="settle-h" className="mp-subtitle">{t('admin.settle.title')}</h3>
      <p className="mp-muted">{t('admin.settle.text', { net: formatMnt(net) })}</p>
      {settle.isError ? <Alert className="mp-banner" type="error" showIcon role="alert" message={errorMessage(settle.error)} /> : null}
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => settle.mutate(v)} disabled={settle.isPending}>
        <Form.Item validateFirst name="settlementRef" label={t('admin.settle.ref')} rules={[{ required: true, whitespace: true, message: t('validation.settlementRef') }, { min: 3, max: 100, message: t('validation.settlementRef') }]}>
          <Input maxLength={100} placeholder={t('admin.settle.ref.placeholder')} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={settle.isPending}>{t('admin.settle.submit')}</Button>
      </Form>
    </section>
  );
}

function AdminLeaseBody({ lease }: { lease: PosLeaseAdminView }) {
  const r = lease.review;
  return (
    <div className="mp-admin-lease">
      <div className="mp-admin-head">
        <StatusTag status={lease.status} />
        <span className="mp-muted">{lease.merchantName} · {lease.storeName} · {lease.planName}</span>
      </div>

      {lease.status === 'REFERRED' ? <ReviewForm id={lease.id} /> : null}
      {lease.status === 'DELIVERED' ? <SettleForm id={lease.id} net={lease.quote.merchantNetAmount} /> : null}

      <h3 className="mp-subtitle">{t('admin.decision.title')}</h3>
      <Dl rows={[
        [t('admin.decision.result'), lease.decision.result ? t(`pos.decision.${lease.decision.result}`) : '—'],
        [t('admin.decision.by'), lease.decision.decidedBy ? t(`pos.decidedBy.${lease.decision.decidedBy}`) : '—'],
        [t('admin.decision.at'), formatDateTime(lease.decision.decidedAt)],
        [t('admin.decision.seconds'), formatDuration(lease.decision.decisionSeconds)],
        [t('admin.decision.publicReason'), lease.decision.publicReason ? t(`pos.public.${lease.decision.publicReason}`) : '—'],
        [t('admin.decision.dti'), formatPercent(r.dtiRatio, 1)],
        ...(r.comment ? [[t('admin.decision.comment'), r.comment] as [string, string]] : []),
        ...(r.settlementRef ? [[t('admin.decision.settlementRef'), r.settlementRef] as [string, string]] : []),
      ]} />

      <h3 className="mp-subtitle">{t('admin.reasons.title')}</h3>
      {r.reasons.length === 0 ? <p className="mp-muted">{t('admin.reasons.none')}</p> : (
        <ul className="mp-reasons" aria-label={t('admin.reasons.title')}>
          {r.reasons.map((x, i) => (
            <li key={`${x.code}-${i}`}>
              <ToneTag tone={SEVERITY_COLOR[x.severity]}>{t(`pos.severity.${x.severity}`)}</ToneTag>
              <span>{t(`pos.reason.${x.code}`)}</span>
            </li>
          ))}
        </ul>
      )}

      {r.affordability ? (
        <>
          <h3 className="mp-subtitle">{t('admin.afford.title')}</h3>
          <Dl rows={[
            [t('admin.afford.maxMonthly'), formatMnt(r.affordability.maxMonthlyPayment)],
            [t('admin.afford.maxFinanced'), formatMnt(r.affordability.maxFinancedAmount)],
            [t('admin.afford.suggestedDown'), r.affordability.suggestedMinDownPayment === null ? '—' : formatMnt(r.affordability.suggestedMinDownPayment)],
          ]} />
        </>
      ) : null}

      <h3 className="mp-subtitle">{t('detail.goodsBlock')}</h3>
      <Dl rows={[[t('detail.goods'), lease.goods.name], [t('detail.category'), t(`goodsCategory.${lease.goods.category}`)], [t('detail.price'), formatMnt(lease.goods.price)]]} />
      <h3 className="mp-subtitle">{t('detail.buyerBlock')}</h3>
      <Dl rows={[...(lease.buyer.fullName ? [[t('detail.buyerName'), lease.buyer.fullName] as [string, string]] : []), [t('detail.register'), lease.buyer.registerMasked], [t('detail.phone'), lease.buyer.phoneMasked]]} />

      <QuoteBreakdown quote={lease.quote} />
      <h3 className="mp-subtitle">{t('detail.timeline')}</h3>
      <LeaseTimeline timeline={lease.timeline} />
    </div>
  );
}

function DrawerInner({ leaseId, onClose }: { leaseId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: backOfficeKeys.lease(leaseId), queryFn: ({ signal }) => getAdminLease(leaseId, { signal }) });
  return (
    <Drawer open width="min(720px, 100vw)" onClose={onClose} destroyOnHidden title={q.data ? t('admin.drawer.title', { no: q.data.leaseNo }) : t('admin.drawer.loading')}>
      {q.isPending ? <Skeleton active paragraph={{ rows: 10 }} /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <AdminLeaseBody lease={q.data} />}
    </Drawer>
  );
}

/** Back-office: лизингийн дотоод харагдац (шалтгаан, ӨОХ, чадамж, timeline) + REFERRED → хянах, DELIVERED → settle. */
export function AdminLeaseDrawer({ leaseId, onClose }: { leaseId: string | null; onClose: () => void }) {
  return leaseId ? <DrawerInner leaseId={leaseId} onClose={onClose} /> : null;
}
