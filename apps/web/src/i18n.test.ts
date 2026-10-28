import { describe, expect, it } from 'vitest';
import { DataScope, MENU, NotificationType, UserRole } from '@los/contracts';
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
    const keys = [...UserRole.map((r) => `auth.role.${r}`), ...DataScope.map((s) => `auth.scope.${s}`), ...NotificationType.map((n) => `shell.notifications.type.${n}`)];
    for (const k of keys) expect(t(k), k).not.toBe(k);
  });
  it('interpolates {params} and falls back to the key', () => {
    expect(t('shell.home.welcome', { name: 'Бат' })).toBe('Сайн байна уу, Бат');
    expect(t('shell.notifications.aria', { n: 3 })).toBe('Мэдэгдэл, 3 уншаагүй');
    expect(t('no.such.key')).toBe('no.such.key');
  });
});
