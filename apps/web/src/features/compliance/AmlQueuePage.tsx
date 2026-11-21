'use client';
import { useState } from 'react';
import type { AmlQueueTab } from './aml.utils';
import { AmlQueueView } from './AmlQueueView';
import { useAmlQueue } from './useAml';

/** Compliance · AML шалгалтын дараалал. Цэс, gateway — `aml:review` (COMPLIANCE). */
export function AmlQueuePage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [tab, setTab] = useState<AmlQueueTab>('OPEN');
  const queue = useAmlQueue({ limit: pageSize, offset: (page - 1) * pageSize, status: tab });
  return (
    <AmlQueueView
      items={queue.data?.items ?? []}
      total={queue.data?.total ?? 0}
      page={page}
      pageSize={pageSize}
      tab={tab}
      loading={queue.isFetching}
      error={queue.error}
      onTabChange={(next) => { setTab(next); setPage(1); }}
      onPageChange={(p, size) => { setPage(size === pageSize ? p : 1); setPageSize(size); }}
    />
  );
}
