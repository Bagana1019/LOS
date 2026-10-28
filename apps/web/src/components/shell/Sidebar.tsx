'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useMemo } from 'react';
import { Layout, Menu, theme, type MenuProps } from 'antd';
import type { MenuItem } from '@los/contracts';
import { t } from '@los/ui';
import { activeHref } from '../../lib/access';
import { brand, BrandLogo } from '../../theme/brand';
import { menuIcon } from './menu-icons';

type Item = Required<MenuProps>['items'][number];
type Go = (href: string, e: ReactMouseEvent | ReactKeyboardEvent) => void;
const toItems = (menu: readonly MenuItem[], go: Go): Item[] =>
  menu.map((i) => ({
    key: i.href,
    icon: menuIcon(i.id),
    // Link (prefetch, "шинэ табд нээх") + мөрийн хоосон хэсэг дээр дарсан ч шилжинэ
    label: <Link href={i.href}>{t(i.labelKey)}</Link>,
    ...(i.children?.length ? { children: toItems(i.children, go), onTitleClick: ({ domEvent }: { domEvent: ReactMouseEvent | ReactKeyboardEvent }) => go(i.href, domEvent) } : {}),
  }));

interface Props {
  menu: readonly MenuItem[];
  collapsed: boolean;
  onCollapse(collapsed: boolean): void;
}

/** Цэсийг web өөрөө шийддэггүй: `GET /api/auth/me`-ийн `menu` (дүрээр шүүгдсэн)-ийг л зурна. */
export function Sidebar({ menu, collapsed, onCollapse }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const { token } = theme.useToken();
  const homeLabel = t('shell.home');
  // Anchor дээр дарсан бол Link өөрөө шилжүүлнэ (давхар history бичлэг үүсгэхгүй)
  const go = useMemo<Go>(() => (href, e) => {
    if (!(e.target as HTMLElement).closest('a')) router.push(href);
  }, [router]);
  const items = useMemo<Item[]>(
    () => [{ key: '/', icon: menuIcon('home'), label: <Link href="/">{homeLabel}</Link> }, ...toItems(menu, go)],
    [menu, homeLabel, go],
  );
  const selected = pathname === '/' ? '/' : activeHref(pathname, menu);
  // Дэд цэстэй бүлгийг үргэлж нээлттэй байлгана: эцэг дээр дарахад (Link + toggle) дэд цэс нуугдаж, дэд хуудас руу шууд орвол сонгосон мөр харагдахгүй болдог
  const parents = useMemo(() => menu.filter((i) => i.children?.length).map((i) => i.href), [menu]);

  return (
    <Layout.Sider
      breakpoint="lg"
      collapsedWidth={64}
      width={232}
      theme="dark"
      collapsible
      trigger={null}
      collapsed={collapsed}
      onCollapse={onCollapse}
      aria-label={t('shell.nav')}
    >
      <Link href="/" style={{ display: 'flex', alignItems: 'center', gap: 10, height: 56, padding: '0 16px', color: token.colorTextLightSolid, fontWeight: 600, fontSize: 16, overflow: 'hidden', whiteSpace: 'nowrap' }}>
        <BrandLogo size={32} />
        <span className="los-brand-name">{brand.name}</span>
      </Link>
      <Menu theme="dark" mode="inline" items={items} onClick={({ key, domEvent }) => go(key, domEvent)} selectedKeys={selected ? [selected] : []} openKeys={collapsed ? undefined : parents} />
    </Layout.Sider>
  );
}
