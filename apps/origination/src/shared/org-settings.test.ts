import { describe, expect, it } from 'vitest';
import { SETTING_REGISTRY } from '@los/contracts';
import type { Tx } from '../prisma.service';
import { OrgSettings } from './org-settings';

// getIn нь өгөгдсөн (tx) холболтоор уншина — SettingsService-ийн pool холболт авахгүй (FOR UPDATE tx дотор pool түгжигдэхээс сэргийлнэ).
describe('OrgSettings.getIn', () => {
  const settings = new OrgSettings({ get: () => { throw new Error('pool connection used'); } } as never);
  const dbWith = (row: { valueJson: unknown } | null) => ({ setting: { findUnique: async () => row } }) as unknown as Tx;

  it('мөр байвал түүний утга, байхгүй бол SETTING_REGISTRY анхдагч', async () => {
    expect(await settings.getIn(dbWith({ valueJson: 45 }), 'org-1', 'inquiry.stale_days')).toBe(45);
    expect(await settings.getIn(dbWith(null), 'org-1', 'inquiry.stale_days')).toBe(SETTING_REGISTRY['inquiry.stale_days'].default);
  });
});
