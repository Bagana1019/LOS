'use client';
import { useRef, useState } from 'react';
import { Alert, Button, Card, Empty, Flex, List, Skeleton, Tag, Typography, App as AntApp } from 'antd';
import { OfficialLetterView } from '@los/contracts';
import { ApiErrorAlert } from '../borrowers/ApiErrorAlert';
import { downloadApplicationFile } from '../documents/shared/files';
import { formatDateTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { useContractDocs, useCreateLetter, usePrintLetter } from './contract.api';

interface Props { applicationId: string; onChanged?: () => void }

/** Жагсаалт createdAt өсөхөөр эрэмбэлэгдэж `№{i + 1}` гэж харагддаг тул бичгийн дугаар нь жагсаалтын байрлал. 0 = олдсонгүй. */
const letterNumber = (letters: readonly OfficialLetterView[], id: string): number => letters.findIndex((l) => l.id === id) + 1;
const revealNew = (el: HTMLElement | null): void => el?.scrollIntoView({ block: 'nearest' });

/** Wizard-н "Албан бичиг" алхам (`/los/loan-application/:id/official_documents`): албан бичиг үүсгэх, татах, хэвлэсэнд тэмдэглэх. FR-11.3. */
export function OfficialDocumentsStep({ applicationId, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const q = useContractDocs(applicationId);
  const create = useCreateLetter(applicationId, onChanged);
  const print = usePrintLetter(applicationId, onChanged);
  // Single-flight: `isPending` дараагийн render хүртэл хоцордог тул нэг task доторх хоёр дарилтыг синхрон ref барина (F4-10).
  const inFlight = useRef(false);
  const [creating, setCreating] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  if (q.isLoading) return <Skeleton active />;
  if (q.error || !q.data) return <ApiErrorAlert error={q.error} onRetry={() => void q.refetch()} />;
  const letters = q.data.letters;
  const fail = (e: unknown) => void message.error(e instanceof Error ? e.message : t('cstep.failed'));
  const createLetter = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setCreating(true);
    try {
      const created = OfficialLetterView.safeParse(await create.mutateAsync({ extra: {} }));
      const fresh = await q.refetch({ cancelRefetch: false }); // onSuccess-ийн invalidate-тэй нэг GET
      const no = created.success ? letterNumber(fresh.data?.letters ?? [], created.data.id) : 0;
      setCreatedId(created.success ? created.data.id : null);
      void message.success(no > 0 ? t('letters.createdNo', { no }) : t('letters.created'));
    } catch {
      // Алдааг `create.error` доорх ApiErrorAlert-д харуулна.
    } finally {
      inFlight.current = false;
      setCreating(false);
    }
  };
  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" wrap gap={8}>
        <Typography.Title level={4} style={{ margin: 0 }}>{t('letters.title')}</Typography.Title>
        <Button type="primary" loading={creating} disabled={creating} data-testid="letter-create" onClick={() => void createLetter()}>{t('letters.create')}</Button>
      </Flex>
      {!q.data.contract ? <Alert type="info" showIcon message={t('letters.hint')} /> : null}
      {create.error || print.error ? <ApiErrorAlert error={create.error ?? print.error} /> : null}
      <Card size="small">
        {letters.length === 0 ? <Empty description={t('letters.empty')} /> : (
          <List dataSource={letters} renderItem={(l, i) => (
            <List.Item actions={[
              l.generatedFileId ? <Button key="d" size="small" onClick={() => void downloadApplicationFile(applicationId, l.generatedFileId as string, `letter-${i + 1}.pdf`).catch(fail)}>{t('cstep.download')}</Button> : null,
              l.printedAt ? null : <Button key="p" size="small" loading={print.isPending} onClick={() => print.mutate(l.id)}>{t('letters.markPrinted')}</Button>,
            ].filter(Boolean)}>
              <span ref={l.id === createdId ? revealNew : undefined}>№{i + 1} · {formatDateTime(l.createdAt)} {l.printedAt ? <Tag color="success">{t('letters.printed')}</Tag> : <Tag>{t('letters.notPrinted')}</Tag>}{l.id === createdId ? <Tag color="processing">{t('letters.new')}</Tag> : null}</span>
            </List.Item>
          )} />
        )}
      </Card>
    </Flex>
  );
}
