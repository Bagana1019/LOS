'use client';

import Link from 'next/link';
import { Button, Result } from 'antd';
import { t } from '@los/ui';

export function NotFoundView() {
  return <Result status="404" title={t('shell.notfound.title')} subTitle={t('shell.notfound.hint')} extra={<Link href="/"><Button type="primary">{t('shell.back_home')}</Button></Link>} />;
}
