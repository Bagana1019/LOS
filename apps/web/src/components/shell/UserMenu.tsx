'use client';

import { useState } from 'react';
import { App, Avatar, Dropdown, Space, Tag, Typography } from 'antd';
import { LogoutOutlined } from '@ant-design/icons';
import type { MeResponse } from '@los/contracts';
import { t } from '@los/ui';
import { useAuth } from '../../lib/auth/auth-context';

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toLocaleUpperCase('mn')).join('') || '?';

export function UserMenu({ user }: { user: MeResponse['user'] }) {
  const { logout } = useAuth();
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    setBusy(true);
    try {
      await logout();
    } catch {
      message.error(t('auth.logout.failed'));
      setBusy(false);
    }
  };

  return (
    <Dropdown
      trigger={['click']}
      placement="bottomRight"
      menu={{
        items: [
          {
            key: 'who',
            disabled: true,
            style: { cursor: 'default' },
            label: (
              <Space direction="vertical" size={4}>
                <Typography.Text strong>{user.fullName}</Typography.Text>
                <span>{user.roles.map((r) => <Tag key={r} color="blue">{t(`role.${r}`)}</Tag>)}</span>
              </Space>
            ),
          },
          { type: 'divider' },
          { key: 'logout', icon: <LogoutOutlined />, danger: true, disabled: busy, label: t('auth.logout'), onClick: () => void signOut() },
        ],
      }}
    >
      <button type="button" aria-label={t('shell.user.menu')} style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 6 }}>
        <Avatar size={28} style={{ background: '#e6f4ff', color: '#1677ff', fontSize: 12 }}>{initials(user.fullName)}</Avatar>
        <span className="los-user-name" style={{ lineHeight: 1.25 }}>
          {user.fullName}
          <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{user.roles.map((r) => t(`role.${r}`)).join(', ')}</Typography.Text>
        </span>
      </button>
    </Dropdown>
  );
}
