'use client';
import { useParams } from 'next/navigation';
import { Alert, App, Spin } from 'antd';
import type { AmlHitReviewRequest } from '@los/contracts';
import { useAuth } from '../../lib/auth/auth-context';
import { t } from '../../lib/i18n';
import { describeAmlError, describeAmlReviewError } from './aml.utils';
import { AmlScreeningView } from './AmlScreeningView';
import { useAmlScreening, useReviewAmlHit } from './useAml';

/** Нэг шалгалтын дэлгэрэнгүй ба hit бүрийн шийдвэр (`/los/compliance/aml/:screeningId`). */
export function AmlScreeningPage() {
  const params = useParams<{ screeningId: string }>();
  const screeningId = params?.screeningId ?? '';
  const { me } = useAuth();
  const { message } = App.useApp();
  const screening = useAmlScreening(screeningId);
  const review = useReviewAmlHit();

  if (screening.isPending) return <Spin />;
  if (screening.error || !screening.data) return <Alert type="error" showIcon message={describeAmlError(screening.error, 'aml.error.LOAD')} />;

  const onReview = (hitId: string, body: AmlHitReviewRequest) =>
    review.mutate({ hitId, body }, {
      onSuccess: () => void message.success(t('aml.review.success')),
      onError: (e) => void message.error(describeAmlReviewError(e)),
    });

  return (
    <AmlScreeningView
      detail={screening.data}
      currentUserId={me?.user.id ?? null}
      submittingHitId={review.isPending ? review.variables?.hitId ?? null : null}
      onReview={onReview}
    />
  );
}
