'use client';
import { Alert } from 'antd';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { isNoAccess } from './errors';
import { useMe } from './hooks';
import { Icon, type IconName } from './icons';
import { NoAccessState } from './states';
import { canCreateLeases, merchantStatusLabel } from './status';

interface NavItem { href: string; labelKey: string; icon: IconName; match: (path: string) => boolean }
const NAV: NavItem[] = [
  { href: '/merchant', labelKey: 'merchant.nav.home', icon: 'home', match: (p) => p === '/merchant' },
  { href: '/merchant/leases/new', labelKey: 'merchant.nav.newLease', icon: 'plus', match: (p) => p.startsWith('/merchant/leases/new') },
  { href: '/merchant/leases', labelKey: 'merchant.nav.leases', icon: 'list', match: (p) => p.startsWith('/merchant/leases') && !p.startsWith('/merchant/leases/new') },
];

/** Мерчантын shell: толгой (мерчант · дэлгүүр · дүр), desktop-д зүүн цэс, утсанд (<768px) доод tab bar. Лизингийн байгууллагын цэс энд байхгүй. */
export function MerchantShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const me = useMe();
  const profile = me.data;
  const store = profile ? profile.stores.find((s) => s.id === profile.currentStoreId) : undefined;
  const storeLabel = profile ? (store ? store.name : t('merchant.allStores')) : '';
  const blocked = me.isError && isNoAccess(me.error);

  return (
    <div className="mp-shell">
      <aside className="mp-side">
        <Link className="mp-brand" href="/merchant" aria-label={t('merchant.brand')}>
          <span className="mp-brand-mark" aria-hidden="true">R</span>
          <span className="mp-brand-text">{t('merchant.brand')}<small>{t('merchant.brand.sub')}</small></span>
        </Link>
        <nav aria-label={t('merchant.nav.label')} className="mp-nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="mp-nav-link" aria-current={n.match(pathname) ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>{t(n.labelKey)}</span>
            </Link>
          ))}
        </nav>
      </aside>

      <header className="mp-head">
        <div className="mp-head-id">
          <span className="mp-head-brand" aria-hidden="true">R</span>
          <div className="mp-head-text">
            <strong className="mp-head-name">{profile ? profile.merchant.name : t('merchant.brand')}</strong>
            {profile ? <span className="mp-head-store"><Icon name="store" size={14} />{storeLabel}</span> : null}
          </div>
        </div>
        {profile ? <span className="mp-role-chip">{t(`merchant.role.${profile.role}`)}</span> : null}
      </header>

      <main className="mp-main" id="main">
        {blocked ? (
          <NoAccessState onRetry={() => void me.refetch()} />
        ) : (
          <>
            {profile && !canCreateLeases(profile.merchant.status) ? (
              <Alert className="mp-banner" type="warning" showIcon message={t('merchant.inactive.title', { status: merchantStatusLabel(profile.merchant.status) })} description={t('merchant.inactive.text')} />
            ) : null}
            {children}
          </>
        )}
      </main>

      <nav className="mp-tabbar" aria-label={t('merchant.nav.label')}>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className="mp-tab" aria-current={n.match(pathname) ? 'page' : undefined}>
            <Icon name={n.icon} size={22} />
            <span>{t(n.labelKey)}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
