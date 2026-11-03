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
import { useCreateCustomer, useXypFetch } from './useCustomers';

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
  const xyp = useXypFetch();
  const create = useCreateCustomer();
  const canWrite = !!me && me.permissions.includes('customer:write');

  const type = register ? customerTypeOfRegister(register) : null;
  const initial = useMemo<Partial<CustomerInputRaw>>(() => (mode?.kind === 'xyp' ? mode.result.prefill : {}), [mode]);
  const existing = mode?.kind === 'xyp' ? mode.result.existing : null;

  const reset = () => { setMode(null); setRegister(null); setLocalError(null); xyp.reset(); create.reset(); };

  const check = () => {
    const normalized = normalizeRegisterNo(input);
    setLocalError(null);
    setMode(null);
    create.reset();
    if (!customerTypeOfRegister(normalized)) { setLocalError(t('error.INVALID_REGISTER_NO')); return; }
    setRegister(normalized);
    xyp.mutate(normalized, { onSuccess: (result) => setMode({ kind: 'xyp', result }) });
  };

  const submit = (payload: Record<string, unknown>) => {
    create.mutate({ ...payload, source: mode?.kind === 'xyp' && mode.result.fetchedAt ? 'XYP' : 'MANUAL' }, {
      onSuccess: (c) => { void message.success(t('customer.new.success')); router.push(`/customer/${c.id}`); },
    });
  };

  const xypErr = xyp.error ? describeCustomerError(xyp.error) : null;
  const createErr = create.error ? describeCustomerError(create.error) : null;
  const isExists = create.error instanceof ApiError && create.error.code === 'CUSTOMER_EXISTS';
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
            data-testid="customer-register" value={input} onChange={(e) => setInput(e.target.value)} onPressEnter={check} disabled={!!mode && !existing}
            placeholder="УБ90010112" maxLength={16} style={{ maxWidth: 260 }} status={localError ? 'error' : undefined} autoFocus
          />
          {mode && !existing ? (
            <Button onClick={reset}>{t('customer.new.reset')}</Button>
          ) : (
            <Button type="primary" data-testid="customer-check" loading={xyp.isPending} onClick={check}>{t('customer.new.check')}</Button>
          )}
        </Flex>
        <div style={{ marginTop: 4 }}><Text type="secondary">{t('customer.new.registerHint')}</Text></div>
        {localError ? <div><Text type="danger">{localError}</Text></div> : null}
      </Card>

      {xypErr && !mode ? (
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
              action={isExists ? <Button size="small" onClick={openExisting}>{t('customer.action.openExisting')}</Button> : undefined}
            />
          ) : null}
          <CustomerForm customerType={type} registerNo={register} initial={initial} prefilled={mode.kind === 'xyp' ? mode.result.prefilledFields : []} serverIssues={serverIssues} submitting={create.isPending} onSubmit={submit} />
        </>
      ) : null}
    </div>
  );
}
