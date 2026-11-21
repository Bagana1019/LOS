'use client';
import { Tag, Tooltip } from 'antd';
import type { AmlHit } from '@los/contracts';
import { t } from '../../lib/i18n';

/** Hit-ийн түвшин: БЛОКЛОХ = шийдвэрлэх хүртэл хүсэлт илгээгдэхгүй, Анхааруулга = зөвхөн мэдэгдэнэ. Тайлбар нь tooltip-д (хулганаар эсвэл фокусаар). */
export function SeverityTag({ severity }: { severity: AmlHit['severity'] }) {
  return (
    <Tooltip title={t(`aml.severity.hint.${severity}`)} trigger={['hover', 'focus']}>
      <Tag color={severity === 'BLOCKING' ? 'red' : 'gold'} tabIndex={0}>{t(`aml.severity.${severity}`)}</Tag>
    </Tooltip>
  );
}
