// CLAUDE.md §2: dwh-sync never writes to the operational DB. Enforced at startup: the DWH URL must not resolve to DATABASE_URL's database.
type Env = Record<string, string | undefined>;

const target = (url: string) => {
  const u = new URL(url);
  return `${u.hostname.toLowerCase()}:${u.port || '5432'}${u.pathname}`;
};

/** `DWH_DATABASE_URL`, validated. Error messages never include credentials. */
export function resolveDwhUrl(env: Env): string {
  const url = env.DWH_DATABASE_URL;
  if (!url) throw new Error('DWH_DATABASE_URL is required for dwh-sync');
  let dwh: string;
  try { dwh = target(url); } catch { throw new Error('DWH_DATABASE_URL is not a valid URL'); }
  if (env.DATABASE_URL) {
    let operational: string | null = null;
    try { operational = target(env.DATABASE_URL); } catch { operational = null; }
    if (operational === dwh) throw new Error('DWH_DATABASE_URL points to the operational database (DATABASE_URL); dwh-sync must only write to the DWH');
  }
  return url;
}
