'use client';
import type { OtpSent, PosLeaseView } from '@los/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Form, Input, Spin } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';
import { formatCountdown, formatMnt } from '../../../lib/format';
import { t } from '../../../lib/i18n';
import { acceptLease, cancelLease, deliverLease, merchantKeys, requestAcceptOtp, resendConsentOtp, submitLease } from '../../../lib/merchant-api';
import { errorMessage, leaseStateMayHaveChanged, retryAfterSeconds } from '../errors';
import { useCountdown } from '../hooks';
import { LinkButton } from '../LinkButton';
import { StatePanel } from '../states';
import { can, publicReasonLabel } from '../status';
import { CancelModal } from './CancelModal';
import { OtpEntry } from './OtpEntry';
import { storeOtp, useStoredOtp } from './otp-store';
import { buildRetryHref } from './prefill';

/** Зөвшөөрөл/санал хүлээн авах кодыг илгээсний дараах хүлээлтийн хугацааг тооцоолно (OTP_RESEND_TOO_SOON-д). */
const syntheticResendAt = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();

function useLeaseActions(lease: PosLeaseView) {
  const qc = useQueryClient();
  const id = lease.id;
  const apply = (next: PosLeaseView) => {
    qc.setQueryData(merchantKeys.lease(id), next);
    void qc.invalidateQueries({ queryKey: merchantKeys.leasesAll() });
    void qc.invalidateQueries({ queryKey: merchantKeys.dashboardAll() });
  };
  // Амжилтгүй болсон ч серверийн төлөв өөрчлөгдсөн байж болно (жишээ: зөвшөөрөл хадгалагдсаны дараа лавлагаа 503, өөр кассир цуцалсан, мерчант түдгэлзсэн):
  // 409/5xx/INVALID_TRANSITION/SCREENING_UNAVAILABLE үед лизингийг дахин татаж allowedActions-ийг сервертэй тулгана. OTP_INVALID зэрэгт татахгүй (төлөв хэвээр).
  const resync = (e: unknown) => {
    if (leaseStateMayHaveChanged(e)) void qc.invalidateQueries({ queryKey: merchantKeys.lease(id) });
  };
  return {
    submit: useMutation({ mutationFn: (otp?: string) => submitLease(id, otp ? { otp } : {}), onSuccess: apply, onError: resync }),
    resendConsent: useMutation({ mutationFn: () => resendConsentOtp(id), onSuccess: (otp) => storeOtp(qc, id, otp), onError: resync }),
    requestAccept: useMutation({ mutationFn: () => requestAcceptOtp(id), onSuccess: (otp) => storeOtp(qc, id, otp), onError: resync }),
    accept: useMutation({ mutationFn: (otp: string) => acceptLease(id, { otp }), onSuccess: apply, onError: resync }),
    deliver: useMutation({ mutationFn: (serialNo?: string) => deliverLease(id, serialNo ? { serialNo } : {}), onSuccess: apply, onError: resync }),
    cancel: useMutation({ mutationFn: (reason: string) => cancelLease(id, { reason }), onSuccess: apply, onError: resync }),
    storeSynthetic: (purpose: OtpSent['purpose'], seconds: number) => {
      const base = qc.getQueryData<OtpSent>(['merchant', 'otp', id, purpose]);
      storeOtp(qc, id, { purpose, phoneMasked: base?.phoneMasked ?? lease.buyer.phoneMasked, expiresAt: base?.expiresAt ?? syntheticResendAt(300), resendAvailableAt: syntheticResendAt(seconds) });
    },
  };
}

function PanelShell({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={`mp-panel mp-action-panel${className ? ` ${className}` : ''}`} aria-label={t('panel.label')}>{children}</section>;
}

/** Серверийн allowedActions-д дараагийн үйлдэл алга (мерчант түдгэлзсэн/идэвхгүй, POS-BR-10) → үхсэн товч биш, зөвхөн тайлбар. */
function InactiveNote({ actions }: { actions?: ReactNode }) {
  return <StatePanel icon="lock" tone="warning" title={t('panel.inactive.title')} description={t('panel.inactive.text')} actions={actions ? <div className="mp-panel-actions">{actions}</div> : undefined} />;
}

/** Статусаас хамаарсан үйлдлийн самбар. Юу хийж болохыг серверийн `allowedActions` шийднэ (docs/05 §4). */
export function LeasePanel({ lease, onAcceptStageChange }: { lease: PosLeaseView; onAcceptStageChange?: (stage: boolean) => void }) {
  const actions = useLeaseActions(lease);
  const [cancelOpen, setCancelOpen] = useState(false);
  const consentOtp = useStoredOtp(lease.id, 'CONSENT');
  const acceptOtp = useStoredOtp(lease.id, 'ACCEPT');
  const [acceptRequested, setAcceptStage] = useState(() => lease.status === 'APPROVED' && !!acceptOtp && new Date(acceptOtp.expiresAt).getTime() > Date.now());
  // Хүлээн зөвшөөрөх (ACCEPT) эрх алга болбол (мерчант түдгэлзсэн) кодын алхмыг харуулахгүй, төлөвийг буцаана.
  const acceptAllowed = can(lease, 'ACCEPT');
  const acceptStage = acceptRequested && acceptAllowed;
  useEffect(() => { if (acceptRequested && lease.status === 'APPROVED' && !acceptAllowed) setAcceptStage(false); }, [acceptRequested, acceptAllowed, lease.status]);
  useEffect(() => { onAcceptStageChange?.(acceptStage); }, [acceptStage, onAcceptStageChange]);
  const offerLeft = useCountdown(lease.status === 'APPROVED' ? lease.expiresAt : null);
  const qc = useQueryClient();
  useEffect(() => {
    // Санал хугацаа дуусвал серверээс шинэ төлөв (EXPIRED) авна.
    if (lease.status === 'APPROVED' && offerLeft === 0) void qc.invalidateQueries({ queryKey: merchantKeys.lease(lease.id) });
  }, [offerLeft, lease.status, lease.id, qc]);

  const cancelButton = can(lease, 'CANCEL') ? (
    <>
      <Button type="link" danger className="mp-cancel-link" onClick={() => setCancelOpen(true)}>{t('pos.action.CANCEL')}</Button>
      <CancelModal open={cancelOpen} onClose={() => setCancelOpen(false)} onConfirm={(reason) => actions.cancel.mutateAsync(reason)} />
    </>
  ) : null;

  switch (lease.status) {
    case 'DRAFT': {
      // Шийдвэр гарах хүртэл (SUBMIT дуудлага) "Шийдвэр гаргаж байна" харуулна. OTP талбар DOM-д үлдэнэ (нуугдана) —
      // буруу кодын алдаа, үлдсэн оролдлогын мессеж алга болохгүй байхын тулд.
      const deciding = actions.submit.isPending ? (
        <PanelShell className="mp-deciding">
          <div className="mp-deciding-body" role="status" aria-live="polite">
            <Spin size="large" />
            <h2 className="mp-panel-title">{t('panel.deciding.title')}</h2>
            <p className="mp-muted">{t('panel.deciding.text')}</p>
          </div>
        </PanelShell>
      ) : null;
      if (can(lease, 'RESEND_CONSENT_OTP')) {
        return (
          <>
            {deciding}
            <div hidden={deciding !== null}>
              <PanelShell>
                <OtpEntry
                  title={t('panel.consent.title')}
                  description={t('panel.consent.text')}
                  phoneMasked={consentOtp?.phoneMasked ?? lease.buyer.phoneMasked}
                  expiresAt={consentOtp?.expiresAt}
                  resendAvailableAt={consentOtp?.resendAvailableAt ?? null}
                  onSubmit={(code) => actions.submit.mutateAsync(code)}
                  onResend={async () => {
                    try {
                      await actions.resendConsent.mutateAsync();
                    } catch (e) {
                      const wait = retryAfterSeconds(e);
                      if (wait !== null) actions.storeSynthetic('CONSENT', wait);
                      throw e;
                    }
                  }}
                >
                  <div className="mp-panel-foot">{cancelButton}</div>
                </OtpEntry>
              </PanelShell>
            </div>
          </>
        );
      }
      if (deciding) return deciding;
      // SUBMIT эрхгүй (мерчант идэвхгүй) бол "Шийдвэр гаргах" товч харуулахгүй.
      if (!can(lease, 'SUBMIT')) return <PanelShell><InactiveNote actions={cancelButton} /></PanelShell>;
      return (
        <PanelShell>
          <h2 className="mp-panel-title">{t('panel.retrySubmit.title')}</h2>
          <p className="mp-muted">{t('panel.retrySubmit.text')}</p>
          {actions.submit.isError ? <p className="mp-otp-error" role="alert">{errorMessage(actions.submit.error)}</p> : null}
          <div className="mp-panel-actions">
            <Button type="primary" size="large" loading={actions.submit.isPending} onClick={() => actions.submit.mutate(undefined)}>{t('panel.retrySubmit.button')}</Button>
            {cancelButton}
          </div>
        </PanelShell>
      );
    }

    case 'REFERRED':
      return (
        <PanelShell>
          <StatePanel icon="clock" tone="neutral" title={t('panel.referred.title')} description={t('panel.referred.text')} actions={<div className="mp-panel-actions"><LinkButton href="/merchant/leases">{t('panel.toList')}</LinkButton>{cancelButton}</div>} />
        </PanelShell>
      );

    case 'APPROVED': {
      if (acceptStage) {
        return (
          <PanelShell>
            <OtpEntry
              title={t('panel.accept.title')}
              description={t('panel.accept.text')}
              phoneMasked={acceptOtp?.phoneMasked ?? lease.buyer.phoneMasked}
              expiresAt={acceptOtp?.expiresAt}
              resendAvailableAt={acceptOtp?.resendAvailableAt ?? null}
              onSubmit={(code) => actions.accept.mutateAsync(code)}
              onResend={() => actions.requestAccept.mutateAsync()}
            >
              <div className="mp-panel-foot"><Button type="link" onClick={() => setAcceptStage(false)}>{t('merchant.back')}</Button>{cancelButton}</div>
            </OtpEntry>
          </PanelShell>
        );
      }
      return (
        <PanelShell className="mp-offer">
          <StatePanel icon="check" tone="success" title={t('panel.approved.title')} description={t('panel.approved.text')} />
          <div className="mp-offer-main">
            <span className="mp-quote-label">{t('quote.monthly')}</span>
            <span className="mp-offer-amount" data-testid="offer-monthly">{formatMnt(lease.quote.monthlyPayment)}</span>
            <span className="mp-quote-term">{t('quote.perMonth', { term: lease.quote.termMonths })}</span>
          </div>
          <p className={`mp-offer-expiry${offerLeft !== null && offerLeft <= 300 ? ' is-soon' : ''}`}>
            <span aria-hidden="true">⏱ </span>
            {offerLeft === null ? null : offerLeft > 0 ? t('panel.approved.expiresIn', { time: formatCountdown(offerLeft) }) : t('panel.approved.expired')}
          </p>
          <ApproveActions lease={lease} actions={actions} setAcceptStage={setAcceptStage} cancelButton={cancelButton} />
        </PanelShell>
      );
    }

    case 'DECLINED': {
      const suggested = lease.decision.suggestedMinDownPayment;
      return (
        <PanelShell className="mp-declined">
          <StatePanel
            icon="alert"
            tone="warning"
            title={t('panel.declined.title')}
            description={
              <>
                <span className="mp-reason" data-testid="public-reason">{lease.decision.publicReason ? publicReasonLabel(lease.decision.publicReason) : t('pos.public.CREDIT_POLICY')}</span>
                <span className="mp-declined-note">{t('panel.declined.note')}</span>
              </>
            }
            actions={
              <div className="mp-panel-actions">
                {suggested !== null ? (
                  <LinkButton type="primary" size="large" href={buildRetryHref(lease, suggested)}>{t('panel.declined.retryWithDown', { amount: formatMnt(suggested) })}</LinkButton>
                ) : null}
                <LinkButton size="large" href="/merchant/leases/new" type={suggested !== null ? 'default' : 'primary'}>{t('merchant.cta.newLease')}</LinkButton>
              </div>
            }
          />
        </PanelShell>
      );
    }

    case 'ACCEPTED':
      // DELIVER эрхгүй (мерчант PENDING/TERMINATED) бол хүлээлгэн өгөх форм харуулахгүй.
      if (!can(lease, 'DELIVER')) return <PanelShell><InactiveNote actions={cancelButton} /></PanelShell>;
      return (
        <PanelShell>
          <h2 className="mp-panel-title">{t('panel.accepted.title')}</h2>
          <p className="mp-muted">{t('panel.accepted.text')}</p>
          <DeliverForm onDeliver={(serialNo) => actions.deliver.mutateAsync(serialNo)} busy={actions.deliver.isPending} error={actions.deliver.error} />
          <div className="mp-panel-foot">{cancelButton}</div>
        </PanelShell>
      );

    case 'DELIVERED':
      return (
        <PanelShell>
          <StatePanel icon="check" tone="success" title={t('panel.delivered.title')} description={t('panel.delivered.text', { net: formatMnt(lease.quote.merchantNetAmount) })} actions={<div className="mp-panel-actions"><LinkButton type="primary" size="large" href="/merchant/leases/new">{t('merchant.cta.newLease')}</LinkButton><LinkButton size="large" href="/merchant/leases">{t('panel.toList')}</LinkButton></div>} />
        </PanelShell>
      );

    case 'SETTLED':
      return (
        <PanelShell>
          <StatePanel icon="check" tone="success" title={t('panel.settled.title')} description={t('panel.settled.text', { net: formatMnt(lease.quote.merchantNetAmount) })} actions={<LinkButton type="primary" size="large" href="/merchant/leases/new">{t('merchant.cta.newLease')}</LinkButton>} />
        </PanelShell>
      );

    case 'CANCELLED':
      return (
        <PanelShell>
          <StatePanel icon="alert" tone="neutral" title={t('panel.cancelled.title')} description={lease.cancelReason ? t('panel.cancelled.reason', { reason: lease.cancelReason }) : undefined} actions={<LinkButton type="primary" size="large" href="/merchant/leases/new">{t('merchant.cta.newLease')}</LinkButton>} />
        </PanelShell>
      );

    case 'EXPIRED':
      return (
        <PanelShell>
          <StatePanel icon="clock" tone="warning" title={t('panel.expired.title')} description={t('panel.expired.text')} actions={<LinkButton type="primary" size="large" href={buildRetryHref(lease)}>{t('panel.expired.restart')}</LinkButton>} />
        </PanelShell>
      );

    default:
      return null;
  }
}

function ApproveActions({ lease, actions, setAcceptStage, cancelButton }: { lease: PosLeaseView; actions: ReturnType<typeof useLeaseActions>; setAcceptStage: (v: boolean) => void; cancelButton: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const request = async () => {
    setMessage(null);
    try {
      await actions.requestAccept.mutateAsync();
      setAcceptStage(true);
    } catch (e) {
      const wait = retryAfterSeconds(e);
      if (wait !== null) {
        // Код саяхан илгээгдсэн — шууд код оруулах алхам руу, хүлээлтийн тоологчтойгоор.
        actions.storeSynthetic('ACCEPT', wait);
        setAcceptStage(true);
        return;
      }
      setMessage(errorMessage(e));
    }
  };
  const canRequest = can(lease, 'REQUEST_ACCEPT_OTP');
  return (
    <div className="mp-panel-actions mp-panel-actions-stack">
      {canRequest ? (
        <Button type="primary" size="large" block loading={actions.requestAccept.isPending} onClick={() => void request()} className="mp-big-btn">{t('panel.approved.confirm')}</Button>
      ) : <InactiveNote />}
      {message ? <p className="mp-otp-error" role="alert">{message}</p> : null}
      {cancelButton}
    </div>
  );
}

function DeliverForm({ onDeliver, busy, error }: { onDeliver: (serialNo?: string) => Promise<unknown>; busy: boolean; error: unknown }) {
  const [form] = Form.useForm<{ serialNo?: string }>();
  const message = error ? errorMessage(error) : null;
  return (
    <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => void onDeliver(v.serialNo?.trim() || undefined).catch(() => undefined)} className="mp-deliver-form">
      <Form.Item name="serialNo" label={t('panel.accepted.serial')} extra={t('panel.accepted.serial.hint')} rules={[{ max: 64, message: t('validation.serial') }]}>
        <Input size="large" maxLength={64} autoFocus autoComplete="off" />
      </Form.Item>
      {message ? <p className="mp-otp-error" role="alert">{message}</p> : null}
      <Button type="primary" size="large" htmlType="submit" block loading={busy} className="mp-big-btn">{t('panel.accepted.deliver')}</Button>
    </Form>
  );
}
