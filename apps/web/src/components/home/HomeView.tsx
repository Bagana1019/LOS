'use client';

import Link from 'next/link';
import { Card, Col, Descriptions, Row, Space, Tag, Typography } from 'antd';
import { resolveDataScope } from '@los/contracts';
import { t } from '@los/ui';
import { flattenMenu } from '../../lib/access';
import { useAuth } from '../../lib/auth/auth-context';
import { menuIcon } from '../shell/menu-icons';

/** Нүүр: хэрэглэгчийн дүр, харах хүрээ, дүрт нээлттэй хэсгүүдийн товчлол (бүгд `/auth/me`-ээс). */
export function HomeView() {
  const { me } = useAuth();
  if (!me) return null;
  const { user, menu } = me;
  return (
    <Space direction="vertical" size="large" style={{ display: 'flex' }}>
      <Card>
        <Typography.Title level={3} style={{ marginTop: 0 }}>{t('home.welcome', { name: user.fullName })}</Typography.Title>
        <Descriptions column={{ xs: 1, md: 2 }} size="small">
          <Descriptions.Item label={t('home.role')}>
            {user.roles.map((r) => <Tag key={r} color="blue">{t(`role.${r}`)}</Tag>)}
          </Descriptions.Item>
          <Descriptions.Item label={t('home.scope')}>{t(`scope.${resolveDataScope(user.roles)}`)}</Descriptions.Item>
        </Descriptions>
      </Card>
      <section aria-labelledby="quick-links">
        <Typography.Title level={5} id="quick-links">{t('home.quick_links')}</Typography.Title>
        <Row gutter={[16, 16]}>
          {flattenMenu(menu).map((i) => (
            <Col key={i.id} xs={24} sm={12} xl={8}>
              <Link href={i.href}>
                <Card hoverable size="small">
                  <Space size={12}>
                    <span style={{ fontSize: 18 }}>{menuIcon(i.id)}</span>
                    <span>{t(i.labelKey)}</span>
                  </Space>
                </Card>
              </Link>
            </Col>
          ))}
        </Row>
      </section>
    </Space>
  );
}
