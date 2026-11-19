'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { App as AntApp, Alert, Button, Card, Flex, Input, Space, Typography } from 'antd';
import { customerTypeOfRegister, normalizeRegisterNo, type CustomerInputRaw, type XypFetchResult } from '@los/contracts';
import { t } from '../../lib/i18n';
import { ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth/auth-context';
import { CustomerForm } from './CustomerForm';
import { describeCustomerError } from './customer-error';
import { lookupCustomer } from './customers.api';
import { xypOtpToFetchResult } from './customers.utils';
import { useCreateCustomer, useXypFetch, useXypOtp } from './useCustomers';
import { XypOtpStep } from './XypOtpStep';

const { Title, Text } = Typography;
type Mode = { kind: 'xyp'; result: XypFetchResult } | { kind: 'manual' };

/** FR-2.1…2.6: регистр → (бүртгэлтэй эсэх, хар жагсаалт) → ХУР-аас татах → дутууг бөглөх → бүртгэх. */
export function CustomerCreatePage() {
  const router = useRouter();
  const { message } = AntApp.useApp();
  const { me } = useAuth();
  const [input, setInput] = useState('');
  const [register, setRegister] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [otpStep, setOtpStep] = useState<{ requestedAt: string } | null>(null);
  const otp = useXypOtp();
  const xyp = useXypFetch();
  const create = useCreateCustomer();
  const canWrite = !!me && me.permissions.includes('customer:write');

  const type = register ? customerTypeOfRegister(register) : null;
  const initial = useMemo<Partial<CustomerInputRaw>>(() => (mode?.kind === 'xyp' ? mode.result.prefill : {}), [mode]);
  const existing = mode?.kind === 'xyp' ? mode.result.existing : null;

  const reset = () => { setMode(null); setRegister(null); setOtpStep(null); setLocalError(null); otp.reset(); xyp.reset(); create.reset(); };

  /** Иргэний зөвшөөрөл, 1-р алхам: ХУР иргэний БҮРТГЭЛТЭЙ утсанд код илгээнэ (бүртгэлтэй харилцагч бол SMS явахгүй, шууд карт). Дахин авахад мөн энэ. */
  const requestCode = (registerNo: string) => {
    const customerType = customerTypeOfRegister(registerNo);
    otp.mutate(registerNo, {
      onSuccess: (res) => {
        xyp.reset();
        if (res.sent && res.requestedAt) setOtpStep({ requestedAt: res.requestedAt });
        else if (customerType) setMode({ kind: 'xyp', result: xypOtpToFetchResult(res, registerNo, customerType) });
      },
    });
  };

  const check = () => {
    const normalized = normalizeRegisterNo(input);
    setLocalError(null);
    setMode(null);
    setOtpStep(null);
    xyp.reset();
    create.reset();
    if (!customerTypeOfRegister(normalized)) { setLocalError(t('error.INVALID_REGISTER_NO')); return; }
    setRegister(normalized);
    requestCode(normalized);
  };

  /** 2-р алхам: иргэний кодоор татна. Код нэг удаагийнх — хадгалахгүй, `snapshotToken`-ийг л `create`-д дамжуулна. */
  const verify = (code: string) => {
    if (!register) return;
    xyp.mutate({ registerNo: register, otp: code }, { onSuccess: (result) => { setOtpStep(null); setMode({ kind: 'xyp', result }); } });
  };

  const submit = (payload: Record<string, unknown>) => {
    const viaXyp = mode?.kind === 'xyp' && !!mode.result.fetchedAt;
    const token = mode?.kind === 'xyp' ? mode.result.snapshotToken : null;
    create.mutate({ ...payload, source: viaXyp ? 'XYP' : 'MANUAL', ...(viaXyp && token ? { xypSnapshotToken: token } : {}) }, {
      onSuccess: (c) => { void message.success(t('customer.new.success')); router.push(`/customer/${c.id}`); },
    });
  };

  const stepError = xyp.error ?? otp.error;
  const xypErr = stepError ? describeCustomerError(stepError) : null;
  const createErr = create.error ? describeCustomerError(create.error) : null;
  const isExists = create.error instanceof ApiError && create.error.code === 'CUSTOMER_EXISTS';
  const isSnapshotExpired = create.error instanceof ApiError && create.error.code === 'XYP_SNAPSHOT_INVALID';
  const openExisting = () => {
    if (!register) return;
    lookupCustomer(register).then((l) => { if (l.customer) router.push(`/customer/${l.customer.id}`); }, () => undefined);
  };
  const serverIssues = useMemo(
    () => (create.error instanceof ApiError && create.error.code === 'VALIDATION_FAILED' ? create.error.issues ?? [] : []),
    [create.error],
  );
  const warnings = mode?.kind === 'xyp' ? mode.result.warnings : [];

  if (me && !canWrite) {
    return <Alert type="warning" showIcon message={t('customer.error.FORBIDDEN')} action={<Button size="small" onClick={() => router.push('/customer')}>{t('customer.card.back')}</Button>} />;
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>{t('customer.new.title')}</Title>
      <Text type="secondary">{t('customer.new.subtitle')}</Text>

      <Card size="small" style={{ margin: '16px 0' }}>
        <Text strong>{t('customer.field.registerNo')}</Text>
        <Flex gap={8} wrap style={{ marginTop: 8 }}>
          <Input
            data-testid="customer-register" value={input} onChange={(e) => setInput(e.target.value)} onPressEnter={check} disabled={(!!mode && !existing) || !!otpStep}
            placeholder="УБ90010112" maxLength={16} style={{ maxWidth: 260 }} status={localError ? 'error' : undefined} autoFocus
          />
          {(mode && !existing) || otpStep ? (
            <Button onClick={reset}>{t('customer.new.reset')}</Button>
          ) : (
            <Button type="primary" data-testid="customer-check" loading={otp.isPending} onClick={check}>{t('customer.new.check')}</Button>
          )}
        </Flex>
        <div style={{ marginTop: 4 }}><Text type="secondary">{t('customer.new.registerHint')}</Text></div>
        {localError ? <div><Text type="danger">{localError}</Text></div> : null}
      </Card>

      {otpStep && !mode ? (
        <XypOtpStep
          requestedAt={otpStep.requestedAt} errorMessage={xypErr?.message ?? null} submitting={xyp.isPending} resending={otp.isPending}
          onSubmit={verify} onResend={() => { if (register) requestCode(register); }} onManual={() => { setOtpStep(null); setMode({ kind: 'manual' }); }} onCancel={reset}
        />
      ) : null}

      {xypErr && !mode && !otpStep ? (
        <Alert
          style={{ marginBottom: 16 }} type="warning" showIcon message={t('customer.new.xypFailed')} description={xypErr.message}
          action={register && customerTypeOfRegister(register) && xypErr.code !== 'INVALID_REGISTER_NO' ? <Button size="small" onClick={() => setMode({ kind: 'manual' })}>{t('customer.new.manual')}</Button> : undefined}
        />
      ) : null}

      {existing ? (
        <Alert
          style={{ marginBottom: 16 }} type="info" showIcon
          message={t('customer.new.existing', { name: [existing.lastName, existing.firstName].filter(Boolean).join(' ') })}
          action={<Button size="small" type="primary" onClick={() => router.push(`/customer/${existing.id}`)}>{t('customer.action.openExisting')}</Button>}
        />
      ) : null}

      {warnings.map((w) => (
        <Alert key={w.reasonCode + w.registeredAt} style={{ marginBottom: 16 }} type="warning" showIcon message={t('blacklist.warning.title')} description={`${w.reasonText ?? w.reasonCode} — ${t('blacklist.warning.note')}`} />
      ))}

      {mode && !existing && register && type ? (
        <>
          {mode.kind === 'xyp' ? (
            <Space direction="vertical" style={{ marginBottom: 16, width: '100%' }}>
              {mode.result.prefilledFields.length ? <Alert type="success" showIcon message={t('customer.new.prefilledNote', { count: mode.result.prefilledFields.length })} /> : null}
              {mode.result.missing.length ? <Alert type="info" showIcon message={t('customer.new.missingNote', { count: mode.result.missing.length })} /> : null}
            </Space>
          ) : null}
          {createErr ? (
            <Alert
              style={{ marginBottom: 16 }} type="error" showIcon message={createErr.message}
              action={isExists
                ? <Button size="small" onClick={openExisting}>{t('customer.action.openExisting')}</Button>
                : isSnapshotExpired ? <Button size="small" data-testid="customer-restart-xyp" onClick={reset}>{t('customer.new.restartXyp')}</Button> : undefined}
            />
          ) : null}
          <CustomerForm customerType={type} registerNo={register} initial={initial} prefilled={mode.kind === 'xyp' ? mode.result.prefilledFields : []} serverIssues={serverIssues} submitting={create.isPending} onSubmit={submit} />
        </>
      ) : null}
    </div>
  );
}
