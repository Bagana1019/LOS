'use client';
import Link from 'next/link';
import { Card, Col, Flex, Row, Typography } from 'antd';
import { t } from '../../lib/i18n';

const ITEMS = [
  { href: '/settings/approval-levels', key: 'approval_levels' },
  { href: '/settings/branches', key: 'branches' },
  { href: '/settings/contract-number', key: 'contract_number' },
  { href: '/settings/parameters', key: 'parameters' },
  { href: '/settings/audit', key: 'audit' },
  { href: '/settings/notifications', key: 'notifications' },
  { href: '/settings/merchants', key: 'merchants' },
] as const;

/** `/settings` — M13 админ цэс. */
export function SettingsHome() {
  return (
    <div>
      <Flex vertical gap={4} style={{ marginBottom: 16 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>{t('admin.home.title')}</Typography.Title>
        <Typography.Text type="secondary">{t('admin.home.subtitle')}</Typography.Text>
      </Flex>
      <Row gutter={[16, 16]}>
        {ITEMS.map((i) => (
          <Col xs={24} md={12} xl={8} key={i.key}>
            <Link href={i.href} style={{ display: 'block' }}>
              <Card hoverable title={t(`admin.nav.${i.key}`)}>
                <Typography.Text type="secondary">{t(`admin.nav.${i.key}.hint`)}</Typography.Text>
              </Card>
            </Link>
          </Col>
        ))}
      </Row>
    </div>
  );
}

export function BackLink() {
  return <Link href="/settings">← {t('admin.common.back')}</Link>;
}
