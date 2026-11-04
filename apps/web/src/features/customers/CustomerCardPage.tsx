'use client';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Button, Card, Descriptions, Flex, Skeleton, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { BlacklistWarning, CustomerAddress, CustomerApplicationRef } from '@los/contracts';
import { formatMoney, t } from '../../lib/i18n';
import { roleKey } from '../borrowers/borrowers.utils';
import { describeCustomerError } from './customer-error';
import { useCustomerCard } from './useCustomers';

const { Title, Text } = Typography;
const dash = '—';
const addr = (a: CustomerAddress | null) => (a ? [a.province, a.district, a.khoroo, a.detail].filter(Boolean).join(', ') : dash);

/** FR-2.6: харилцагчийн карт (унших) + өмнөх зээлийн түүх. */
export function CustomerCardPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const card = useCustomerCard(id);
  const c = card.data;

  if (card.isPending) return <Skeleton active paragraph={{ rows: 8 }} />;
  if (card.isError || !c) {
    return (
      <Alert type="error" showIcon message={t('customer.card.loadError')} description={describeCustomerError(card.error).message}
        action={<Button size="small" onClick={() => router.push('/customer')}>{t('customer.card.back')}</Button>} />
    );
  }

  const yn = (v: boolean) => (v ? t('customer.yes') : t('customer.no'));
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
        <Button onClick={() => router.push('/customer')}>{t('customer.card.back')}</Button>
      </Flex>

      {c.warnings.map((w: BlacklistWarning) => (
        <Alert key={w.reasonCode + w.registeredAt} style={{ marginTop: 12 }} type="warning" showIcon message={t('blacklist.warning.title')} description={`${w.reasonText ?? w.reasonCode} — ${t('blacklist.warning.note')}`} />
      ))}

      <Card size="small" title={t('customer.group.personal')} style={{ marginTop: 16 }}>
        <Descriptions size="small" column={{ xs: 1, md: 2 }}>
          {c.customerType === 'INDIVIDUAL' ? <Descriptions.Item label={t('customer.field.clanName')}>{c.clanName ?? dash}</Descriptions.Item> : null}
          {c.customerType === 'INDIVIDUAL' ? <Descriptions.Item label={t('customer.field.civilId')}>{c.civilId ?? dash}</Descriptions.Item> : null}
          <Descriptions.Item label={t('customer.field.gender')}>{c.gender ? t(`customer.gender.${c.gender}`) : dash}</Descriptions.Item>
          <Descriptions.Item label={t('customer.field.birthDate')}>{c.birthDate ?? dash}</Descriptions.Item>
          <Descriptions.Item label={t('customer.field.phone')}>{c.phone ?? dash}</Descriptions.Item>
          <Descriptions.Item label={t('customer.field.email')}>{c.email ?? dash}</Descriptions.Item>
          <Descriptions.Item label={t('customer.field.familySize')}>{c.familySize ?? dash}</Descriptions.Item>
          <Descriptions.Item label={t('customer.field.maritalStatus')}>{c.maritalStatus ? t(`customer.maritalStatus.${c.maritalStatus}`) : dash}</Descriptions.Item>
          <Descriptions.Item label={t('customer.field.activitySector')}>{c.activitySector ?? dash}</Descriptions.Item>
          <Descriptions.Item label={t('customer.field.segment')}>{c.segment ?? dash}</Descriptions.Item>
          <Descriptions.Item label={t('customer.field.education')}>{c.education ?? dash}</Descriptions.Item>
          <Descriptions.Item label={t('customer.xyp.fetchedAt')}>{c.xypFetchedAt ? c.xypFetchedAt.slice(0, 10) : dash}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size="small" title={t('customer.group.address')} style={{ marginTop: 16 }}>
        <Descriptions size="small" column={1}>
          <Descriptions.Item label={t('customer.field.officialAddress')}>{addr(c.officialAddress)}</Descriptions.Item>
          <Descriptions.Item label={t('customer.field.residenceAddress')}>{c.residenceSameAsOfficial ? t('customer.field.residenceSameAsOfficial') : addr(c.residenceAddress)}</Descriptions.Item>
        </Descriptions>
      </Card>

      {c.employment ? (
        <Card size="small" title={t('customer.group.employment')} style={{ marginTop: 16 }}>
          <Descriptions size="small" column={{ xs: 1, md: 2 }}>
            <Descriptions.Item label={t('customer.field.employment.organization')}>{c.employment.organization}</Descriptions.Item>
            <Descriptions.Item label={t('customer.field.employment.position')}>{c.employment.position}</Descriptions.Item>
            <Descriptions.Item label={t('customer.field.employment.address')}>{c.employment.address ?? dash}</Descriptions.Item>
            <Descriptions.Item label={t('customer.field.employment.phone')}>{c.employment.phone ?? dash}</Descriptions.Item>
          </Descriptions>
        </Card>
      ) : null}

      {c.contacts.length ? (
        <Card size="small" title={t('customer.group.contacts')} style={{ marginTop: 16 }}>
          {c.contacts.map((k) => (
            <div key={k.id}>{t(`customer.relation.${k.relation}`)}: {[k.lastName, k.firstName].filter(Boolean).join(' ')} · {k.phone}{k.homeAddress ? ` · ${addr(k.homeAddress)}` : ''}</div>
          ))}
        </Card>
      ) : null}

      <Card size="small" title={t('customer.group.kyc')} style={{ marginTop: 16 }}>
        <Descriptions size="small" column={{ xs: 1, md: 3 }}>
          <Descriptions.Item label={t('customer.field.isRelatedParty')}>{yn(c.isRelatedParty)}</Descriptions.Item>
          <Descriptions.Item label={t('customer.field.isPep')}>{yn(c.isPep)}</Descriptions.Item>
          <Descriptions.Item label={t('customer.field.amlRiskScore')}>{c.amlRiskScore ?? dash}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size="small" title={t('customer.loanHistory')} style={{ marginTop: 16 }}>
        <Table<CustomerApplicationRef> rowKey="id" size="small" pagination={false} dataSource={c.applications} columns={appCols} locale={{ emptyText: t('customer.card.noApplications') }} />
      </Card>
    </div>
  );
}
