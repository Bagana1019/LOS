'use client';
import { Card, Descriptions } from 'antd';
import type { CustomerAddress, CustomerView } from '@los/contracts';
import { t } from '../../lib/i18n';

const dash = '—';
const addr = (a: CustomerAddress | null) => (a ? [a.province, a.district, a.khoroo, a.detail].filter(Boolean).join(', ') : dash);

/** FR-2.6: харилцагчийн картын унших хэсэг (хувийн мэдээлэл, хаяг, хөдөлмөр, холбоо барих хүмүүс, KYC). Засах горимд оронд нь `CustomerEditPanel`. */
export function CustomerDetailCards({ c }: { c: CustomerView }) {
  const yn = (v: boolean) => (v ? t('customer.yes') : t('customer.no'));
  return (
    <>
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
    </>
  );
}
