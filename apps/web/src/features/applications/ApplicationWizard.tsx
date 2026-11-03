'use client';
import type { ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Button, Flex, Modal, Skeleton, Tag, Typography, App as AntApp } from 'antd';
import { WizardLayout, type WizardStage } from '@los/ui';
import { STAGE1_STEPS, STAGE2_STEPS, type ApplicationDetail } from '@los/contracts';
import { ApiError } from '../../lib/api';
import { t } from '../../lib/i18n';
import { describeApplicationError, stepHref } from './applications.utils';
import { useApplication, useTransition } from './useApplications';

/** Серверийн дэлгэрэнгүй → WizardLayout-ийн үе шатууд (6/9 тоолуур, цоож). */
export function toStages(app: ApplicationDetail): WizardStage[] {
  const view = (keys: readonly string[]) => keys.map((key) => {
    const s = app.steps.find((x) => x.stepKey === key);
    return { key, label: t(`application.step.${key}`), status: s?.status ?? 'LOCKED', hint: s?.required ? t('application.wizard.requiredTag') : undefined } as const;
  });
  return [
    { key: 'stage1', title: t('application.wizard.stage1'), counter: t('application.wizard.counter', { done: app.stage1Completed, total: app.stage1Total }), steps: [...view(STAGE1_STEPS)] },
    { key: 'stage2', title: t('application.wizard.stage2'), steps: [...view(STAGE2_STEPS)] },
  ];
}

/** `/los/loan-application/:id/*` бүх хуудсыг ороох wizard: зүүн самбар (алхмын төлөв, тоолуур, цоож) + Илгээх (G1). FR-1, docs/01 §2.2. */
export function ApplicationWizard({ children }: { children: ReactNode }) {
  const { id, step } = useParams<{ id: string; step?: string }>();
  const router = useRouter();
  const { message } = AntApp.useApp();
  const query = useApplication(id);
  const transition = useTransition(id);
  const app = query.data;

  if (query.isPending) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (!app) {
    const status = query.error instanceof ApiError ? query.error.status : 0;
    return <Alert type="error" showIcon message={status === 403 || status === 404 ? t('application.wizard.notFound') : t('application.wizard.loadFailed')} action={<Button size="small" onClick={() => router.push('/los/loan-application')}>{t('application.wizard.back')}</Button>} />;
  }

  const submitTransition = app.transitions.find((x) => x.to === 'SUBMITTED' && x.allowed);
  const submit = () => {
    Modal.confirm({
      title: t('application.submit.confirmTitle'), content: t('application.submit.confirmBody'), okText: t('application.submit.ok'), cancelText: t('application.submit.cancel'),
      onOk: () => transition.mutateAsync({ to: 'SUBMITTED' }).then(() => void message.success(t('application.submit.success'))).catch((e: unknown) => void message.error(describeApplicationError(e, 'application.submit.failed'))),
    });
  };

  const header = (
    <div style={{ marginBottom: 16 }}>
      <Button type="link" style={{ padding: 0 }} onClick={() => router.push('/los/loan-application')}>← {t('application.wizard.back')}</Button>
      <Flex align="center" gap={8} wrap style={{ marginTop: 4 }}>
        <Typography.Title level={4} style={{ margin: 0 }} data-testid="app-no">{app.appNo}</Typography.Title>
        <Tag data-testid="app-status">{t(`status.${app.status}`)}</Tag>
      </Flex>
      <Button block style={{ marginTop: 8 }} data-testid="wizard-bsa" onClick={() => router.push(`/los/bsa/${encodeURIComponent(app.id)}`)}>{t('application.wizard.bsa')}</Button>
      {submitTransition ? <Button type="primary" block style={{ marginTop: 12 }} loading={transition.isPending} data-testid="submit-application" onClick={submit}>{t('application.submit.button')}</Button> : null}
    </div>
  );

  return (
    <WizardLayout
      stages={toStages(app)}
      activeKey={step ?? ''}
      onSelect={(key) => router.push(stepHref(app.id, key))}
      header={header}
      lockedTitle={t('application.wizard.locked')}
      statusLabel={(s) => t(`application.stepStatus.${s}`)}
    >
      {children}
    </WizardLayout>
  );
}
