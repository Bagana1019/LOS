import { describe, expect, it } from 'vitest';
import { MENU, NotificationType, UserRole } from '@los/contracts';
import { mn, mnSources, t } from '@los/ui';
import { flattenMenu } from './lib/access';

describe('mn i18n', () => {
  it('has no key defined in two module files (spread would silently override)', () => {
    const seen = new Map<string, string>();
    for (const [file, dict] of Object.entries(mnSources)) {
      for (const key of Object.keys(dict)) {
        expect(seen.get(key), `"${key}" is in both "${seen.get(key)}" and "${file}"`).toBeUndefined();
        seen.set(key, file);
      }
    }
    expect(Object.keys(mn).length).toBe(seen.size);
  });
  it('has no empty strings', () => {
    for (const [k, v] of Object.entries(mn)) expect(v.trim(), k).not.toBe('');
  });
  it('translates every menu label the gateway can send', () => {
    for (const i of flattenMenu(MENU)) expect(t(i.labelKey), i.labelKey).not.toBe(i.labelKey);
  });
  it('translates roles, data scopes and notification types', () => {
    for (const r of UserRole) expect(t(`role.${r}`)).not.toBe(`role.${r}`);
    for (const s of ['NONE', 'OWN', 'BRANCH', 'ALL']) expect(t(`scope.${s}`)).not.toBe(`scope.${s}`);
    for (const n of NotificationType) expect(t(`notification.type.${n}`)).not.toBe(`notification.type.${n}`);
  });
  it('interpolates {params} and falls back to the key', () => {
    expect(t('home.welcome', { name: 'Бат' })).toBe('Сайн байна уу, Бат');
    expect(t('shell.notifications.aria', { n: 3 })).toBe('Мэдэгдэл, 3 уншаагүй');
    expect(t('no.such.key')).toBe('no.such.key');
  });
});
