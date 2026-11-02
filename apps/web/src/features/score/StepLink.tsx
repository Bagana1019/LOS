'use client';
import Link from 'next/link';
import { theme } from 'antd';
import type { ReasonStep } from '@los/contracts';
import { t } from '../../lib/i18n';
import { stepHref, stepKey } from './score.utils';

/** FR-8.6: шалтгааныг засах wizard-ийн алхам руу линк (`/los/loan-application/:id/<step>`). */
export function StepLink({ applicationId, step }: { applicationId: string; step: ReasonStep }) {
  const { token } = theme.useToken();
  return (
    <Link href={stepHref(applicationId, step)} style={{ color: token.colorLink }}>
      {t('score.reason.fix', { step: t(stepKey(step)) })}
    </Link>
  );
}
