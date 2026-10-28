'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Layout, Result, Spin } from 'antd';
import type { MeResponse } from '@los/contracts';
import { t } from '@los/ui';
import { canAccess, isPublicPath, safeNext } from '../../lib/access';
import { useAuth } from '../../lib/auth/auth-context';
import { HeaderSearch } from './HeaderSearch';
import { NotificationBell } from './NotificationBell';
import { Sidebar } from './Sidebar';
import { UserMenu } from './UserMenu';

const Loading = () => <Spin fullscreen size="large" tip={t('shell.loading')} />;

function Frame({ me, children }: { me: MeResponse; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <a className="los-skip" href="#main">{t('shell.skip')}</a>
      <Sidebar menu={me.menu} />
      <Layout>
        <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 16, height: 56, lineHeight: 'normal', borderBottom: '1px solid rgba(5, 5, 5, 0.06)' }}>
          <HeaderSearch me={me} />
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <NotificationBell />
            <UserMenu user={me.user} />
          </div>
        </Layout.Header>
        <Layout.Content id="main" style={{ padding: 24, minWidth: 0 }}>
          {canAccess(pathname, me.permissions) ? (
            children
          ) : (
            <Result status="403" title={t('shell.forbidden.title')} subTitle={t('shell.forbidden.hint')} extra={<Link href="/"><Button type="primary">{t('shell.back_home')}</Button></Link>} />
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}

/** Нэвтрэлтийн хаалга: сесс сэргээгдтэл хүлээнэ, нэвтрээгүй бол /login руу (next-тэй), нэвтэрсэн бол shell. */
export function AppShell({ children }: { children: ReactNode }) {
  const { status, me, retry } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = isPublicPath(pathname);

  useEffect(() => {
    if (status === 'anonymous' && !isPublic) {
      const here = `${pathname}${window.location.search}`;
      router.replace(here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`);
    } else if (status === 'authenticated' && isPublic) {
      router.replace(safeNext(new URLSearchParams(window.location.search).get('next')));
    }
  }, [status, isPublic, pathname, router]);

  if (status === 'booting') return <Loading />;
  if (status === 'unreachable') {
    return <Result status="error" title={t('shell.unreachable.title')} subTitle={t('shell.unreachable.hint')} extra={<Button type="primary" onClick={retry}>{t('shell.retry')}</Button>} />;
  }
  if (isPublic) return status === 'anonymous' ? <>{children}</> : <Loading />;
  if (status !== 'authenticated' || !me) return <Loading />;
  return <Frame me={me}>{children}</Frame>;
}
