'use client';
import { Alert, Flex, Skeleton, Tag, Typography } from 'antd';
import type { NotificationChannel, PreviewTemplateResponse } from '@los/contracts';
import { t } from '../../lib/i18n';
import { NotificationErrorAlert } from './NotificationErrorAlert';

interface Props {
  channel: NotificationChannel;
  /** Урьдчилан харах хүсэлт илгээх боломжгүй (агуулга хоосон г.м.). */
  disabled: boolean;
  loading: boolean;
  error: unknown;
  data: PreviewTemplateResponse | undefined;
}

/** SMS-ийн зорилтот хязгаар: 2 сегмент. */
const SMS_MAX_SEGMENTS = 2;

/** Загварыг жишээ утгаар render хийсэн байдал (сервер талаас). Имэйлийн html-г sandbox iframe-д харуулна (скрипт ажиллахгүй). */
export function TemplatePreview({ channel, disabled, loading, error, data }: Props) {
  if (disabled && !data) return <Typography.Text type="secondary">{t('notification.templates.preview.unavailable')}</Typography.Text>;
  if (error) return <NotificationErrorAlert error={error} title={t('notification.templates.preview.error')} />;
  if (!data) return loading ? <Skeleton active paragraph={{ rows: 4 }} /> : null;

  const bodyLength = [...data.body].length;
  return (
    <Flex vertical gap={12} style={{ opacity: loading ? 0.6 : 1 }}>
      {data.unknownPlaceholders.length > 0 ? (
        <Alert type="warning" showIcon message={t('notification.templates.error.unknownPlaceholders', { names: data.unknownPlaceholders.join(', ') })} description={t('notification.templates.preview.unknownHint')} />
      ) : null}

      {data.subject ? (
        <div>
          <Typography.Text type="secondary">{t('notification.templates.field.subject')}</Typography.Text>
          <div><Typography.Text strong>{data.subject}</Typography.Text></div>
        </div>
      ) : null}

      {channel === 'EMAIL' && data.html ? (
        <iframe
          title={t('notification.templates.preview.emailFrame')}
          sandbox=""
          srcDoc={data.html}
          style={{ width: '100%', height: 260, border: '1px solid rgba(128,128,128,0.35)', borderRadius: 6, background: '#fff' }}
        />
      ) : (
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0, padding: 12, borderRadius: 6, background: 'rgba(128,128,128,0.1)' }}>{data.body}</Typography.Paragraph>
      )}

      {data.smsSegments !== null ? (
        <Flex gap={8} align="center" wrap>
          <Tag color={data.smsSegments > SMS_MAX_SEGMENTS ? 'warning' : 'success'}>{t('notification.templates.preview.smsSegments', { segments: data.smsSegments, length: bodyLength })}</Tag>
          {data.smsSegments > SMS_MAX_SEGMENTS ? <Typography.Text type="warning">{t('notification.templates.preview.smsTooLong', { max: SMS_MAX_SEGMENTS })}</Typography.Text> : null}
        </Flex>
      ) : null}
    </Flex>
  );
}
