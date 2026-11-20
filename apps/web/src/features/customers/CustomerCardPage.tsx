'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Button, Card, Flex, Skeleton, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { BlacklistWarning, CustomerApplicationRef } from '@los/contracts';
import { formatMoney, t } from '../../lib/i18n';
import { roleKey } from '../borrowers/borrowers.utils';
import { useAuth } from '../../lib/auth/auth-context';
import { CustomerDetailCards } from './CustomerDetailCards';
import { CustomerEditPanel } from './CustomerEditPanel';
import { consumeCustomerCreated } from './customer-created-flag';
import { describeCustomerError } from './customer-error';
import { StartApplicationAlert, useStartApplication } from './StartApplication';
import { canEditCustomer } from './customers.utils';
import { useCustomerCard } from './useCustomers';

const { Title, Text } = Typography;
const dash = '—';

/** FR-2.6: харилцагчийн карт (унших) + өмнөх зээлийн түүх. */
export function CustomerCardPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const card = useCustomerCard(id);
  const { me } = useAuth();
  const [editing, setEditing] = useState(false);
  const startApp = useStartApplication(id);
  const [justCreated, setJustCreated] = useState(false);
  useEffect(() => { if (consumeCustomerCreated(id)) setJustCreated(true); }, [id]); // бүртгэсний дараа шилжсэн бол тогтвортой амжилтын баннер
  const c = card.data;

  if (card.isPending) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (card.isError || !c) {
    return (
      <Alert type="error" showIcon message={t('customer.card.loadError')} description={describeCustomerError(card.error).message}
        action={<Button size="small" onClick={() => router.push('/customer')}>{t('customer.card.back')}</Button>} />
    );
  }

  const editability = canEditCustomer(me, c);
  const canApply = !!me && me.permissions.includes('application:write'); // хүсэлт үүсгэх: өөр салбарын харилцагчид ч болно (NFR-3: зөвхөн засвар хязгаарлагдана)
  const appCols: ColumnsType<CustomerApplicationRef> = [
    { title: t('customer.card.application.appNo'), dataIndex: 'appNo', key: 'appNo', render: (v: string, r) => <a href={`/los/loan-application/${r.id}`} onClick={(e) => { e.preventDefault(); router.push(`/los/loan-application/${r.id}`); }}>{v}</a> },
    { title: t('customer.card.application.role'), dataIndex: 'role', key: 'role', render: (v: string) => t(roleKey(v as never)) },
    { title: t('customer.card.application.status'), dataIndex: 'status', key: 'status', render: (v: string) => <Tag>{t(`status.${v}`)}</Tag> },
    { title: t('customer.card.application.amount'), key: 'amount', align: 'right', render: (_, r) => (r.amount ? formatMoney(Number(r.amount), r.currency) : dash) },
    { title: t('customer.card.application.contractNo'), dataIndex: 'contractNo', key: 'contractNo', render: (v: string | null) => v ?? dash },
  ];

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <Flex justify="space-between" align="flex-start" wrap gap={12}>
        <div>
          <Title level={3} style={{ marginTop: 0, marginBottom: 4 }}>{[c.lastName, c.firstName].filter(Boolean).join(' ')}</Title>
          <Flex gap={8} wrap>
            <Tag>{t(`customer.type.${c.customerType}`)}</Tag>
            <Text type="secondary">{c.registerNo}</Text>
            {c.isPep ? <Tag color="orange">{t('customer.flag.pep')}</Tag> : null}
            {c.isRelatedParty ? <Tag color="gold">{t('customer.flag.related')}</Tag> : null}
          </Flex>
        </div>
        <Flex gap={8} wrap>
          {!editing && canApply ? (
            <Button type="primary" data-testid="customer-start-application" loading={startApp.isPending} onClick={startApp.start}>{t('customer.card.startApplication')}</Button>
          ) : null}
          {!editing ? <Button data-testid="customer-edit" disabled={!editability.editable} onClick={() => setEditing(true)}>{t('customer.card.edit')}</Button> : null}
          <Button onClick={() => router.push('/customer')}>{t('customer.card.back')}</Button>
        </Flex>
      </Flex>

      {/* NFR-3: өөр салбарын харилцагч — харж, хүсэлтэд холбож болно, засахгүй (сервер 403 CUSTOMER_BRANCH_FORBIDDEN) */}
      {editability.reason === 'OTHER_BRANCH' ? (
        <Alert style={{ marginTop: 12 }} type="info" showIcon data-testid="customer-other-branch" message={t('customer.card.otherBranch')} description={t('customer.card.otherBranchHint')} />
      ) : null}
      {me && editability.reason === 'NO_PERMISSION' ? (
        <Alert style={{ marginTop: 12 }} type="info" showIcon data-testid="customer-edit-blocked" message={t('customer.card.noWritePermission')} description={t('customer.card.noWritePermissionHint')} />
      ) : null}
      <StartApplicationAlert error={startApp.error} />
      {justCreated ? (
        <Alert
          style={{ marginTop: 12 }} type="success" showIcon closable data-testid="customer-created-banner" message={t('customer.new.success')}
          description={canApply ? t('customer.card.createdNext') : undefined} onClose={() => setJustCreated(false)}
        />
      ) : null}

      {c.warnings.map((w: BlacklistWarning) => (
        <Alert key={w.reasonCode + w.registeredAt} style={{ marginTop: 12 }} type="warning" showIcon message={t('blacklist.warning.title')} description={`${w.reasonText ?? w.reasonCode} — ${t('blacklist.warning.note')}`} />
      ))}

      {editing ? (
        <CustomerEditPanel customer={c} onCancel={() => setEditing(false)} onSaved={() => setEditing(false)} />
      ) : (
        <CustomerDetailCards c={c} />
      )}

      <Card size="small" title={t('customer.loanHistory')} style={{ marginTop: 16 }}>
        <Table<CustomerApplicationRef> rowKey="id" size="small" pagination={false} dataSource={c.applications} columns={appCols} locale={{ emptyText: t('customer.card.noApplications') }} />
      </Card>
    </div>
  );
}
