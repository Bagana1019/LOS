import { parseSetting, type SettingKey, type SettingValue } from '@los/contracts';
import { getRequestContext } from '../context/request-context';
import { InternalHttpClient } from './internal-http';

const TTL_MS = 60_000;

/**
 * origination.setting-ийг унших (CLAUDE.md §3.2.8: sync GET, cache 60с). origination өөрөө SettingsService-ээ шууд хэрэглэнэ.
 * Утгыг `SETTING_REGISTRY`-ийн схемээр шалгана; бүртгэлгүй/буруу утга бол алдаа (чимээгүй default хэрэглэхгүй).
 */
export class SettingsClient {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  constructor(private readonly http: InternalHttpClient = new InternalHttpClient(), private readonly now: () => number = Date.now) {}

  async get<K extends SettingKey>(key: K, orgId: string = getRequestContext()?.orgId ?? ''): Promise<SettingValue<K>> {
    const ck = `${orgId}:${key}`;
    const hit = this.cache.get(ck);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value as SettingValue<K>;
    const res = await this.http.get<{ key: string; value: unknown }>('origination', `/api/settings/${encodeURIComponent(key)}`);
    const value = parseSetting(key, res.value);
    this.cache.set(ck, { at: this.now(), value });
    return value;
  }
  /** SettingsChanged event хүлээн авахад дуудна. */
  invalidate(key?: string): void {
    if (!key) return void this.cache.clear();
    for (const k of this.cache.keys()) if (k.endsWith(`:${key}`)) this.cache.delete(k);
  }
}
