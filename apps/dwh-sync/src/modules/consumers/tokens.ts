/** Redis Streams bus the dwh-sync consumers subscribe on; `null` when REDIS_URL is unset (service boots, readiness reports consumers down). */
export const DWH_EVENT_BUS = Symbol('DWH_EVENT_BUS');
