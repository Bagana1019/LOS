'use client';

import { Tag, theme } from 'antd';
import type { UserRole } from '@los/contracts';
import { t } from '@los/ui';

/** Дүрийн шошго — өнгийг брэнд (antd theme token)-оос авна, шууд өнгө бичихгүй. */
export function RoleTags({ roles }: { roles: readonly UserRole[] }) {
  const { token } = theme.useToken();
  return (
    <>
      {roles.map((r) => (
        <Tag key={r} style={{ color: token.colorPrimary, background: token.colorPrimaryBg, borderColor: token.colorPrimaryBorder }}>
          {t(`auth.role.${r}`)}
        </Tag>
      ))}
    </>
  );
}
