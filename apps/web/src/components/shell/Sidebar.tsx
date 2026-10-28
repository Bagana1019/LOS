'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { Layout, Menu, type MenuProps } from 'antd';
import type { MenuItem } from '@los/contracts';
import { t } from '@los/ui';
import { activeHref } from '../../lib/access';
import { brand, BrandLogo } from '../../theme/brand';
import { menuIcon } from './menu-icons';

type Item = Required<MenuProps>['items'][number];
const toItems = (menu: readonly MenuItem[]): Item[] =>
  menu.map((i) => ({
    key: i.href,
    icon: menuIcon(i.id),
    label: <Link href={i.href}>{t(i.labelKey)}</Link>,
    ...(i.children?.length ? { children: toItems(i.children) } : {}),
  }));

/** Цэсийг web өөрөө шийддэггүй: `GET /api/auth/me`-ийн `menu` (дүрээр шүүгдсэн)-ийг л зурна. */
export function Sidebar({ menu }: { menu: readonly MenuItem[] }) {
  const pathname = usePathname();
  const homeLabel = t('shell.home');
  const items = useMemo<Item[]>(
    () => [{ key: '/', icon: menuIcon('home'), label: <Link href="/">{homeLabel}</Link> }, ...toItems(menu)],
    [menu, homeLabel],
  );
  const selected = pathname === '/' ? '/' : activeHref(pathname, menu);
  const parents = useMemo(() => menu.filter((i) => i.children?.length).map((i) => i.href), [menu]);

  return (
    <Layout.Sider breakpoint="lg" collapsedWidth={64} width={232} collapsible theme="dark" aria-label={t('shell.nav')}>
      <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, height: 56, padding: '0 16px', color: '#fff', fontWeight: 600, fontSize: 16, overflow: 'hidden', whiteSpace: 'nowrap' }}>
        <BrandLogo size={32} />
        <span className="los-brand-name">{brand.name}</span>
      </Link>
      <Menu theme="dark" mode="inline" items={items} selectedKeys={selected ? [selected] : []} defaultOpenKeys={parents} />
    </Layout.Sider>
  );
}
