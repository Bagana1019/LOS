'use client';

import { Button, Result } from 'antd';
import { t } from '../../../features/esign/i18n';

// Хүлээгдээгүй алдаанд хоосон дэлгэц гаргахгүй. Алдааны дэлгэрэнгүйг (токен агуулсан байж болзошгүй) харуулахгүй, логлохгүй.
export default function SignError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: 16 }}>
      <Result
        status="error"
        title={t('esign.error.title')}
        subTitle={t('esign.error.boundary')}
        extra={
          <Button type="primary" size="large" block onClick={reset}>
            {t('esign.retry')}
          </Button>
        }
      />
    </main>
  );
}
