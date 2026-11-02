'use client';
import { Alert, Flex, Tag, Typography } from 'antd';
import type { DocumentOcrCheck } from '@los/contracts';
import { formatPercent } from '../../lib/format';
import { t } from '../../lib/i18n';
import { OCR_VERDICT_TONE, ocrAdviceKey, ocrVerdictKey, ocrWarningText } from './documents.utils';

const COLOR = { success: 'success', warning: 'warning', error: 'error', default: undefined } as const;

/** OCR тулгалтын дүгнэлт: MATCH / MISMATCH / UNREADABLE / NOT_APPLICABLE + зөвлөмж. OCR нь зөвлөмж — хүн шалгаж баталгаажуулна. Регистр далдлагдсан. */
export function OcrResult({ check }: { check: DocumentOcrCheck }) {
  const tone = OCR_VERDICT_TONE[check.verdict];
  return (
    <Alert
      type={tone === 'success' ? 'success' : tone === 'error' ? 'error' : tone === 'warning' ? 'warning' : 'info'}
      showIcon
      data-testid="ocr-result"
      role="status"
      message={
        <Flex gap={8} align="center" wrap>
          <Typography.Text strong>{t('document.ocr.title')}</Typography.Text>
          <Tag color={COLOR[tone]} style={{ marginInlineEnd: 0 }}>{t(ocrVerdictKey(check.verdict))}</Tag>
          {check.registerMasked ? <Typography.Text type="secondary">{t('document.ocr.register', { value: check.registerMasked })}</Typography.Text> : null}
          {check.confidence !== null ? <Typography.Text type="secondary">{t('document.ocr.confidence', { value: formatPercent(check.confidence, 0) })}</Typography.Text> : null}
        </Flex>
      }
      description={
        <Flex vertical gap={2}>
          <span>{t(ocrAdviceKey(check.verdict))}</span>
          {check.warnings.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {check.warnings.map((w) => (
                <li key={w}>{ocrWarningText(w)}</li>
              ))}
            </ul>
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('document.ocr.humanReview')}</Typography.Text>
        </Flex>
      }
    />
  );
}
