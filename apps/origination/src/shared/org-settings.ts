import { Injectable } from '@nestjs/common';
import { SETTING_REGISTRY, type SettingKey, type SettingValue } from '@los/contracts';
import { systemContext } from '@los/nest-common';
import type { Tx } from '../prisma.service';
import { SettingsService } from '../modules/settings/settings.service';

/** CLAUDE.md §6.2: BR утгыг hardcode хийхгүй — `setting`-ээс (хүснэгтэд байхгүй бол `SETTING_REGISTRY` анхдагч). Контекстгүй газар (cron, consumer)-д orgId-аар. */
@Injectable()
export class OrgSettings {
  constructor(private readonly settings: SettingsService) {}

  async get<K extends SettingKey>(orgId: string, key: K): Promise<SettingValue<K>> {
    return (await this.settings.get(systemContext(orgId), key)).value as SettingValue<K>;
  }

  /**
   * Өгөгдсөн холболтоор (транзакцаар) унших. `get` нь pool-ийн өөр холболт авдаг тул FOR UPDATE түгжээ барьсан транзакц дотроос дуудвал
   * зэрэгцээ хүсэлт бүр хоёр холболт хүлээж, pool (жижиг CI-д 5) дүүрэхэд бүгд түгжигдэж P2024 → 500 болно. Tx дотор үүнийг ашиглана.
   */
  async getIn<K extends SettingKey>(db: Tx, orgId: string, key: K): Promise<SettingValue<K>> {
    const row = await db.setting.findUnique({ where: { orgId_key: { orgId, key } } });
    return (row ? row.valueJson : SETTING_REGISTRY[key].default) as SettingValue<K>;
  }
}
