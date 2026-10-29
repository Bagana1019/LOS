'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Grid, Layout, Result, Spin, theme } from 'antd';
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import type { MeResponse } from '@los/contracts';
import { t } from '@los/ui';
import { canAccess, hasOwnShell, isPublicPath, isStandalonePath, safeNext } from '../../lib/access';
import { useAuth } from '../../lib/auth/auth-context';
import { NotificationBellContainer } from '../../features/notifications/NotificationBellContainer';
import { HeaderSearch } from './HeaderSearch';
import { Sidebar } from './Sidebar';
import { UserMenu } from './UserMenu';

const Loading = () => <Spin fullscreen size="large" tip={t('shell.loading')} />;

function Frame({ me, children }: { me: MeResponse; children: ReactNode }) {
  const pathname = usePathname();
  const { token } = theme.useToken();
  const [collapsed, setCollapsed] = useState(false);
  // lg-ээс нарийн (утас, таблет): sidebar давхарлан гарна, контент бүтэн өргөнөөр (320px хүртэл хэвтээ гүйлгэлтгүй)
  const mobile = Grid.useBreakpoint().lg === false;
  return (
    <Layout hasSider style={{ minHeight: '100vh' }}>
      <a className="los-skip" href="#main">{t('shell.skip')}</a>
      {mobile && !collapsed ? <div className="los-backdrop" onClick={() => setCollapsed(true)} aria-hidden /> : null}
      <Sidebar menu={me.menu} collapsed={collapsed} onCollapse={setCollapsed} mobile={mobile} />
      <Layout style={{ minWidth: 0 }}>
        <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 12, height: 56, lineHeight: 'normal', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined aria-hidden /> : <MenuFoldOutlined aria-hidden />}
            aria-label={t('shell.nav.toggle')}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          />
          <HeaderSearch me={me} />
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <NotificationBellContainer />
            <UserMenu user={me.user} />
          </div>
        </Layout.Header>
        <Layout.Content id="main" style={{ padding: mobile ? 12 : 24, minWidth: 0 }}>
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

/** NFR-3: нэвтрэлтийн хаалга. Сесс сэргээгдтэл хүлээнэ, нэвтрээгүй бол /login руу, нэвтэрсэн бол shell. */
export function AppShell({ children }: { children: ReactNode }) {
  const { status, me, reason, retry } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const standalone = isStandalonePath(pathname);
  const isPublic = isPublicPath(pathname);

  useEffect(() => {
    if (standalone) return;
    if (status === 'anonymous' && !isPublic) {
      // `next` нь сесс дууссан/нэвтрээгүй үед л; хэрэглэгч өөрөө гарсан бол дараагийн хүн өмнөх хуудас руу очихгүй
      const here = `${pathname}${window.location.search}`;
      router.replace(reason === 'signed_out' || here === '/' ? '/login' : `/login?next=${encodeURIComponent(here)}`);
    } else if (status === 'authenticated' && isPublic) {
      router.replace(safeNext(new URLSearchParams(window.location.search).get('next')));
    }
  }, [status, isPublic, standalone, pathname, reason, router]);

  if (standalone) return <>{children}</>;
  if (status === 'booting') return <Loading />;
  if (status === 'unreachable') {
    return <Result status="error" title={t('shell.unreachable.title')} subTitle={t('shell.unreachable.hint')} extra={<Button type="primary" onClick={retry}>{t('shell.retry')}</Button>} />;
  }
  if (isPublic) return status === 'anonymous' ? <>{children}</> : <Loading />;
  if (status !== 'authenticated' || !me) return <Loading />;
  if (hasOwnShell(pathname)) return <>{children}</>;
  return <Frame me={me}>{children}</Frame>;
}
