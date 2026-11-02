'use client';
import { Typography } from 'antd';
import type { MethodReason } from '@los/contracts';
import { t } from '../../lib/i18n';
import { EMPTY_VALUE } from '../../lib/format';
import { StepLink } from './StepLink';
import { reasonText } from './score.utils';

interface Props {
  applicationId: string;
  reasons: readonly MethodReason[];
}

/** FR-8.6: шалтгаан бүр + засах алхам руу линк. Монгол текст `score.reason.<CODE>`, каталогт байхгүй бол серверийн мессеж. */
export function ReasonList({ applicationId, reasons }: Props) {
  if (reasons.length === 0) return <Typography.Text type="secondary">{EMPTY_VALUE}</Typography.Text>;
  return (
    <ul style={{ margin: 0, paddingInlineStart: 18, textAlign: 'left' }}>
      {reasons.map((r) => (
        <li key={`${r.code}:${r.step}`} data-reason={r.code} style={{ marginBottom: 4 }}>
          <span>{reasonText(r, t)}</span>
          <div>
            <StepLink applicationId={applicationId} step={r.step} />
          </div>
        </li>
      ))}
    </ul>
  );
}
