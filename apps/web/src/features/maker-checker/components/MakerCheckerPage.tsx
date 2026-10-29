'use client';
import { Suspense, useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge, Button, Flex, Skeleton, Tabs, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { mn } from '@los/ui';
import { useSummary, mcKeys } from '../hooks';
import { buildUrl, isScopeTab, parseId, parseTab, TAB_KEYS, type PageState, type TabKey } from '../url';
import { AppProviders } from './AppProviders';
import { PoliciesTab } from './PoliciesTab';
import { RequestDrawer } from './RequestDrawer';
import { RequestsTable } from './RequestsTable';
import { useDecisionFlow } from './useDecisionFlow';

const { Title, Text } = Typography;

function Content() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { data: summary } = useSummary();
  const { handlers, modals } = useDecisionFlow();

  // Tab and open request live in the URL (?tab=&id=) so every view is linkable.
  const tab = parseTab(params.get('tab'));
  const id = parseId(params.get('id'));
  const go = useCallback((next: PageState) => router.replace(buildUrl(pathname, next), { scroll: false }), [router, pathname]);

  const count = (key: TabKey): number => (key === 'inbox' ? (summary?.inbox ?? 0) : key === 'mine' ? (summary?.mine ?? 0) : 0);

  return (
    <main style={{ padding: 24, maxWidth: 1600, margin: '0 auto' }}>
      <Flex justify="space-between" align="flex-start" wrap gap={12}>
        <div>
          <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>
            {mn['maker_checker.page.title']}
          </Title>
          <Text type="secondary">{mn['maker_checker.page.subtitle']}</Text>
        </div>
        <Button onClick={() => void queryClient.invalidateQueries({ queryKey: mcKeys.all })}>{mn['maker_checker.page.refresh']}</Button>
      </Flex>

      <Tabs
        activeKey={tab}
        onChange={(key) => go({ tab: key as TabKey })}
        aria-label={mn['maker_checker.page.tabs_aria']}
        items={TAB_KEYS.map((key) => ({
          key,
          label: (
            <span>
              {mn[`maker_checker.tab.${key}`]}
              {count(key) > 0 && <Badge count={count(key)} overflowCount={99} size="small" style={{ marginInlineStart: 8 }} />}
            </span>
          ),
        }))}
      />

      <div role="tabpanel" aria-label={mn[`maker_checker.tab.${tab}`]}>
        {isScopeTab(tab) ? (
          // key: switching tab starts with page 1 and no status filter
          <RequestsTable key={tab} scope={tab} handlers={handlers} onOpen={(requestId) => go({ tab, id: requestId })} />
        ) : (
          <PoliciesTab onOpenRequest={(requestId) => go({ tab: 'mine', id: requestId })} />
        )}
      </div>

      <RequestDrawer id={id} onClose={() => go({ tab })} handlers={handlers} />
      {modals}
    </main>
  );
}

/** /los/maker-checker - requests awaiting a second pair of eyes, plus the policy admin tab. */
export function MakerCheckerPage() {
  return (
    <AppProviders>
      {/* useSearchParams needs a Suspense boundary for static rendering */}
      <Suspense fallback={<Skeleton active style={{ padding: 24 }} paragraph={{ rows: 8 }} />}>
        <Content />
      </Suspense>
    </AppProviders>
  );
}
