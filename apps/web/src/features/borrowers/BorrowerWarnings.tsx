'use client';
import { Alert, Flex, Typography } from 'antd';
import type { BorrowerView, BorrowerWarning } from '@los/contracts';
import { t } from '../../lib/i18n';
import { describeWarning, sortWarnings } from './borrowers.utils';

interface Props {
  warnings: readonly BorrowerWarning[];
  items: readonly BorrowerView[];
}

/** BR-9: хар жагсаалт (улаан), PEP, хамааралтай этгээд, зөвшөөрөл дутуу, баталгаа бага, хувь бүрэн бус (шар). Хадгалахыг хориглохгүй. */
export function BorrowerWarnings({ warnings, items }: Props) {
  if (warnings.length === 0) return null;
  const described = sortWarnings(warnings).map((w) => describeWarning(w, items, t));
  return (
    <Flex vertical gap={8}>
      <Flex align="baseline" gap={8} wrap>
        <Typography.Text strong>{t('borrower.warnings.title')}</Typography.Text>
        <Typography.Text type="secondary">{t('borrower.warnings.note')}</Typography.Text>
      </Flex>
      {described.map((w, index) => (
        <Alert
          key={`${w.code}:${w.customerId ?? ''}:${index}`}
          type={w.severity}
          showIcon
          message={
            <Flex gap={8} wrap>
              <Typography.Text strong>{w.title}</Typography.Text>
              <Typography.Text>{w.description}</Typography.Text>
            </Flex>
          }
        />
      ))}
    </Flex>
  );
}
