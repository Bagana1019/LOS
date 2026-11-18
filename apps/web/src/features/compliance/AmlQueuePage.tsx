'use client';
import { useState } from 'react';
import { AmlQueueView } from './AmlQueueView';
import { useAmlQueue } from './useAml';

/** Compliance · AML шалгалтын дараалал. Цэс, gateway — `aml:review` (COMPLIANCE). */
export function AmlQueuePage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const queue = useAmlQueue({ limit: pageSize, offset: (page - 1) * pageSize });
  return (
    <AmlQueueView
      items={queue.data?.items ?? []}
      total={queue.data?.total ?? 0}
      page={page}
      pageSize={pageSize}
      loading={queue.isFetching}
      error={queue.error}
      onPageChange={(p, size) => { setPage(size === pageSize ? p : 1); setPageSize(size); }}
    />
  );
}
