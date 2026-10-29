import { Injectable } from '@nestjs/common';
import type { SettingKey, SettingValue } from '@los/contracts';
import { systemContext } from '@los/nest-common';
import { SettingsService } from '../modules/settings/settings.service';

/** CLAUDE.md §6.2: BR утгыг hardcode хийхгүй — `setting`-ээс (хүснэгтэд байхгүй бол `SETTING_REGISTRY` анхдагч). Контекстгүй газар (cron, consumer)-д orgId-аар. */
@Injectable()
export class OrgSettings {
  constructor(private readonly settings: SettingsService) {}

  async get<K extends SettingKey>(orgId: string, key: K): Promise<SettingValue<K>> {
    return (await this.settings.get(systemContext(orgId), key)).value as SettingValue<K>;
  }
}
