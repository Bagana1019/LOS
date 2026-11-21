'use client';
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { App as AntApp, Alert, Button } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { t } from '../../lib/i18n';
import { createApplication } from '../applications/applications.api';
import { createIdempotencyKeyHolder, describeApplicationError, resumeHref, shouldRotateIdempotencyKey } from '../applications/applications.utils';
import { applicationsKey } from '../applications/useApplications';
import { addBorrower } from '../borrowers/borrowers.api';
import { describeError as describeBorrowerError } from '../borrowers/borrowers.utils';

/** Ноорог хүсэлт үүссэн ч харилцагчийг зээлдэгчээр холбож чадаагүй: ноорогийг алдахгүй, хэрэглэгч нээж гараар нэмнэ / дахин оролдоно. */
class AttachFailed extends Error {
  constructor(readonly applicationId: string, readonly appNo: string, readonly reason: unknown) {
    super('BORROWER_ATTACH_FAILED');
  }
}

/**
 * F1-15: картаас «Зээлийн хүсэлт үүсгэх». Одоо байгаа endpoint-уудаар: `POST /applications` (ноорог) → `POST /applications/:id/borrowers {customerId, role: PRIMARY}` → wizard.
 * Idempotency-Key нь алдааны дараа дахин оролдоход ижил (сервер давхар ноорог үүсгэхгүй), амжилттай болмогц шинэчлэгдэнэ.
 */
export function useStartApplication(customerId: string) {
  const router = useRouter();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const keys = useMemo(() => createIdempotencyKeyHolder(), []);
  const mutation = useMutation({
    mutationFn: async () => {
      let app;
      try {
        app = await createApplication({}, keys.current());
      } catch (e) {
        if (shouldRotateIdempotencyKey(e)) keys.reset();
        throw e;
      }
      try {
        await addBorrower(app.id, { customerId, role: 'PRIMARY' });
      } catch (e) {
        throw new AttachFailed(app.id, app.appNo, e);
      }
      return app;
    },
    onSuccess: (app) => {
      keys.reset();
      void message.success(t('application.create.success', { appNo: app.appNo }));
      router.push(resumeHref(app.id));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: applicationsKey }),
  });
  return { start: () => mutation.mutate(), isPending: mutation.isPending, error: mutation.error };
}

/** `useStartApplication().error`-ийг харуулна; алдаа байхгүй бол юу ч үгүй. */
export function StartApplicationAlert({ error }: { error: Error | null }) {
  const router = useRouter();
  if (!error) return null;
  if (error instanceof AttachFailed) {
    const reason = describeBorrowerError(error.reason, t).message;
    return (
      <Alert
        style={{ marginTop: 12 }} type="error" showIcon data-testid="customer-start-application-error" message={t('customer.card.startApplicationFailed')}
        description={t('customer.card.startApplicationAttachFailed', { appNo: error.appNo, reason })}
        action={<Button size="small" data-testid="customer-open-draft" onClick={() => router.push(resumeHref(error.applicationId))}>{t('customer.card.openDraft')}</Button>}
      />
    );
  }
  return <Alert style={{ marginTop: 12 }} type="error" showIcon data-testid="customer-start-application-error" message={describeApplicationError(error, 'customer.card.startApplicationFailed')} />;
}
