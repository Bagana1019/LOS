'use client';
import { Flex, Tag } from 'antd';
import type { UnderwritingPolicy } from '@los/contracts';
import { t } from '../../lib/i18n';
import { formatDscr, formatShare } from './score.utils';

/** BR-1…BR-4: бодлогын утгууд серверийн `result.policy`-оос (setting) ирнэ — энд зөвхөн форматлана. */
export function PolicyStrip({ policy }: { policy: UnderwritingPolicy }) {
  const items = [
    t('score.policy.dti', { value: formatShare(policy.maxDti) }),
    t('score.policy.dscr', { value: formatDscr(policy.minDscr) }),
    t('score.policy.ltv', { value: formatShare(policy.maxLtv) }),
    t('score.policy.weight', { value: formatShare(policy.weightThreshold) }),
  ];
  return (
    <Flex wrap gap={8} role="list" aria-label={t('score.policy.title')}>
      {items.map((text) => (
        <Tag key={text} role="listitem" bordered style={{ marginInlineEnd: 0, whiteSpace: 'normal' }}>
          {text}
        </Tag>
      ))}
    </Flex>
  );
}
