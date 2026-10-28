'use client';

import { useState } from 'react';
import { App, Avatar, Dropdown, Space, theme, Typography } from 'antd';
import { LogoutOutlined } from '@ant-design/icons';
import type { MeResponse } from '@los/contracts';
import { t } from '@los/ui';
import { useAuth } from '../../lib/auth/auth-context';
import { RoleTags } from './RoleTags';

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toLocaleUpperCase('mn')).join('') || '?';

export function UserMenu({ user }: { user: MeResponse['user'] }) {
  const { logout } = useAuth();
  const { message } = App.useApp();
  const { token } = theme.useToken();
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
                <span><RoleTags roles={user.roles} /></span>
              </Space>
            ),
          },
          { type: 'divider' },
          { key: 'logout', icon: <LogoutOutlined aria-hidden />, danger: true, disabled: busy, label: t('auth.logout'), onClick: () => void signOut() },
        ],
      }}
    >
      <button
        type="button"
        className="los-user-trigger"
        aria-label={t('shell.user.menu')}
        style={{ background: 'none', border: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 6 }}
      >
        <Avatar size={28} style={{ background: token.colorPrimaryBg, color: token.colorPrimary, fontSize: 12 }}>{initials(user.fullName)}</Avatar>
        <span className="los-user-name" style={{ lineHeight: 1.25, textAlign: 'left' }}>
          {user.fullName}
          <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{user.roles.map((r) => t(`auth.role.${r}`)).join(', ')}</Typography.Text>
        </span>
      </button>
    </Dropdown>
  );
}
